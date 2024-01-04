import { RateLimiterRedis, RateLimiterMemory } from 'rate-limiter-flexible';
import Redis, { Cluster } from 'ioredis';
import { Connection } from '@solana/web3.js';

// Ideas:
// - modify weight based on "closeness" to user. For example, first ping each provider and weight by response time.
// - have default in code as a fallback in case our "remote config" doesn't load properly

export const ERROR_THRESHOLD = 20;
const ERROR_RESET_MS = 60000; // 60 seconds
const DISABLED_RESET_MS = 60000; // 60 seconds
const BASE_RETRY_DELAY = 500; // Base delay for the first retry in milliseconds
const MAX_RETRY_DELAY = 3000; // Maximum delay in milliseconds
const TIMEOUT_MS = 5000;
const KEY_PREFIX = "smart-rpc-rate-limit"

export interface TransportConfig {
    rateLimit: number;
    weight: number;
    blacklist: string[];
    url: string;
    id: string;
    enableSmartDisable: boolean;
    enableFailover: boolean;
    maxRetries: number;
}

interface TransportState {
    errorCount: number;
    lastErrorResetTime: number;
    disabled: boolean;
    disabledTime: number;
    rateLimiter: RateLimiterRedis | RateLimiterMemory;
}

export interface Transport {
    transportConfig: TransportConfig;
    transportState: TransportState;
    connection: Connection;
}

interface Metric {
    method: string;
    id: string;
    latency: number;
    statusCode: number;
}

type MetricCallback = (metricName: string, metricValue: Metric) => void;

export class TransportManager {
    private transports: Transport[] = [];
    private metricCallback?: MetricCallback;
    private redisClient?: Redis | Cluster;
    smartConnection: Connection;

    constructor(initialTransports: TransportConfig[], metricCallback?: MetricCallback, redisClient?: Redis | Cluster) {
        this.metricCallback = metricCallback;
        this.redisClient = redisClient;
        this.updateTransports(initialTransports);

        this.smartConnection = new Proxy(new Connection(this.transports[0].transportConfig.url), {
            get: (target, prop, receiver) => {
                const originalMethod = target[prop];
                if (typeof originalMethod === 'function' && originalMethod.constructor.name === "AsyncFunction") {
                    return (...args) => {
                        let useFanout = false;
                        let useRace = false;

                        if (args.length > 0) {
                            const lastArg = args[args.length - 1];
                            useFanout = typeof lastArg === 'object' && lastArg.fanout;
                            useRace = typeof lastArg === 'object' && lastArg.race;
                        }

                        if (useFanout) {
                            args.pop();
                            return this.fanout(prop, ...args);
                        } else if (useRace) {
                            args.pop();
                            return this.race(prop, ...args);
                        }

                        return this.smartTransport(prop, ...args);
                    };
                }
                
                return Reflect.get(target, prop, receiver);
            }
        })
    }

    settleAllWithTimeout = async <T>(
        promises: Array<Promise<T>>,
        ): Promise<Array<T>> => {
        const values: T[] = [];

        await Promise.allSettled(
            promises.map((promise) =>
                Promise.race([promise, this.timeout(TIMEOUT_MS)]),
            ),
        ).then((result) =>
            result.forEach((d) => {
                if (d.status === 'fulfilled') {
                    values.push(d.value as T);
                }
            }),
        );

        return values;
    };

    // Updates the list of transports based on the new configuration
    updateTransports(newTransports: TransportConfig[]): void {
        this.transports = newTransports.map(config => this.createTransport(config));
    }

    updateMockTransports(newTransports: Transport[]) {
        this.transports = newTransports;
    }

    getTransports(): Transport[] {
        return this.transports;
    }

    // Creates a transport object from configuration
    private createTransport(config: TransportConfig): Transport {
        if (config.id === "" || config.id.includes(" ")) {
            throw new Error("Invalid transport ID. The ID must not be empty and must not contain spaces.");
        }

        let rateLimiter: RateLimiterRedis | RateLimiterMemory;

        // Create a rateLimiter per transport so we can have separate rate limits.
        if (this.redisClient) {
            rateLimiter = new RateLimiterRedis({
                storeClient: this.redisClient,
                points: config.rateLimit,
                duration: 1,
                keyPrefix: `${KEY_PREFIX}:${config.id}`
            });
        } else {
            rateLimiter = new RateLimiterMemory({
                points: config.rateLimit,
                duration: 1,
                keyPrefix: `${KEY_PREFIX}:${config.id}`
            });
        }

        return {
            transportConfig: config,
            transportState: {
                errorCount: 0,
                lastErrorResetTime: Date.now(),
                disabled: false,
                disabledTime: 0,
                rateLimiter
            },
            connection: new Connection(config.url, {
                commitment: "confirmed",
                disableRetryOnRateLimit: true,
            })
        };
    }

    private timeout(ms: number): Promise<any> {
        return new Promise((_, reject) => {
            setTimeout(() => {
                reject(new Error(`Operation timed out after ${ms} milliseconds`));
            }, ms);
        }) as Promise<any>;
    }

    triggerMetricCallback(metricName: string, metricValue: Metric) {
        if (this.metricCallback) {
            try {
                this.metricCallback(metricName, metricValue);
            } catch (e) {
                console.error('Error in metric callback:', e);
            }
        }
    }

    // Selects a transport based on their weights
    selectTransport(availableTransports: Transport[]): Transport {
        let totalWeight = availableTransports.reduce((sum, t) => sum + t.transportConfig.weight, 0);
        let randomNum = Math.random() * totalWeight;
    
        for (const transport of availableTransports) {
            randomNum -= transport.transportConfig.weight;
            if (randomNum <= 0) {
                return transport;
            }
        }
    
        // Fallback to the first transport in case of rounding errors.
        return availableTransports[0];
    }

    async isRateLimitExceeded(transport: Transport): Promise<boolean> {
        try {
            await transport.transportState.rateLimiter.consume(transport.transportConfig.url);
            return false;
        } catch (e) {
            return true;
        }
    }

    private async getAvailableTransports(methodName: string): Promise<Transport[]> {
        // Map transports to an array of promises that resolve to true or false
        const checkPromises = this.transports.map(async (transport) => {
            const isBlacklisted = transport.transportConfig.blacklist.includes(methodName);
            const isRateLimited = await this.isRateLimitExceeded(transport);
            return !isBlacklisted && !isRateLimited;
        });
    
        // Resolve all promises
        const checks = await Promise.all(checkPromises);
    
        // Filter the transports based on the resolved values
        return this.transports.filter((_, index) => checks[index]);
    }

    private async fanout(methodName, ...args): Promise<any[]> {
        const availableTransports = await this.getAvailableTransports(methodName);

        const transportPromises = availableTransports.map(transport => 
            transport.connection[methodName](...args)
        );

        const results = await this.settleAllWithTimeout(
            transportPromises,
        );
    
        return results;
    }

    private async race(methodName, ...args): Promise<any> {
        const availableTransports = await this.getAvailableTransports(methodName);

        const transportPromises = availableTransports.map(transport => 
            Promise.race([
                transport.connection[methodName](...args),
                this.timeout(TIMEOUT_MS)
            ])
        );
    
        return new Promise((resolve, reject) => {
            let errorCount = 0;
            transportPromises.forEach(promise => {
                promise.then(resolve).catch(error => {
                    errorCount++;
                    if (errorCount === transportPromises.length) {
                        reject(new Error("All transports failed or timed out"));
                    }
                });
            });
        });
    }

    // Smart transport function that selects a transport based on weight and checks for rate limit.
    // It includes a retry mechanism with exponential backoff for handling HTTP 429 (Too Many Requests) errors.
    async smartTransport(methodName, ...args): Promise<any[]> {
        let availableTransports = this.transports.filter(t => !t.transportConfig.blacklist.includes(methodName));
    
        while (availableTransports.length > 0) {
            const transport = this.selectTransport(availableTransports);
    
            if (transport.transportState.disabled){
                if (Date.now() - transport.transportState.disabledTime >= DISABLED_RESET_MS){
                    transport.transportState.disabled = false;
                    transport.transportState.disabledTime = 0;
                } else {
                    availableTransports = availableTransports.filter(t => t !== transport);
    
                    continue;
                }
            }
    
            if (!(await this.isRateLimitExceeded(transport))) {
                for (let attempt = 0; attempt <= transport.transportConfig.maxRetries; attempt++) {
                    let latencyStart = Date.now();

                    try {
                        const result = await Promise.race([
                            transport.connection[methodName](...args),
                            this.timeout(TIMEOUT_MS)
                        ]);

                        let latencyEnd = Date.now();
                        let latency = latencyEnd - latencyStart;

                        this.triggerMetricCallback('SuccessfulRequest', { 
                            method: methodName,
                            id: transport.transportConfig.id,
                            latency: latency,
                            statusCode: 200
                        });
    
                        return result;
                    } catch (error: any) {
                        const currentTime = Date.now();

                        let latencyEnd = currentTime;
                        let latency = latencyEnd - latencyStart;

                        this.triggerMetricCallback('ErrorRequest', { 
                            method: methodName,
                            id: transport.transportConfig.id,
                            latency: latency,
                            statusCode: error.statusCode
                        });
    
                        // Reset error count if enough time has passed
                        if (currentTime - transport.transportState.lastErrorResetTime >= ERROR_RESET_MS) {
                            transport.transportState.errorCount = 0;
                            transport.transportState.lastErrorResetTime = currentTime;
                        }
    
                        transport.transportState.errorCount++;
    
                        // Check if the error count exceeds a certain threshold
                        if (transport.transportState.errorCount > ERROR_THRESHOLD && transport.transportConfig.enableSmartDisable) {
                            transport.transportState.disabled = true;
                            transport.transportState.disabledTime = currentTime;
                        }
    
                        // Throw error if max retry attempts has been reached
                        if (attempt === transport.transportConfig.maxRetries) {
                            // If failover is enabled, break so we can try another transport
                            if (transport.transportConfig.enableFailover) {
                                break
                            }
    
                            if (error.statusCode === 429 || (error.response && error.response.status === 429)) {
                                throw new Error("Maximum retry attempts reached for HTTP 429.");
                            } else {
                                throw error;
                            }
                        }
    
                        let delay = Math.min(MAX_RETRY_DELAY, BASE_RETRY_DELAY * Math.pow(2, attempt)); // Exponential backoff calculation
                        await new Promise(resolve => setTimeout(resolve, delay));
                    }
                }
            }
    
            // Remove a transport with exceeded rate limit and retry with the next available one
            availableTransports = availableTransports.filter(t => t !== transport);
        }
    
        // TODO: consider picking one if we want a last ditch effort attempt.
    
        // Throw error if all available transports have been tried without success
        throw new Error("No available transports for the requested method.");
    }
}