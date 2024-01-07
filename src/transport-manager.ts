import { RateLimiterRedis, RateLimiterMemory, RateLimiterQueue } from 'rate-limiter-flexible';
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
const MAX_RATE_LIMITER_QUEUE_SIZE = 500

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
    rateLimiterQueue: RateLimiterQueue;
}

export interface Transport {
    transportConfig: TransportConfig;
    transportState: TransportState;
    connection: Connection;
}

interface TransportManagerConfig {
    strictPriorityMode?: boolean;
    metricCallback?: MetricCallback;
    redisClient?: Redis | Cluster;
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
    private strictPriorityMode: boolean = false;
    smartConnection: Connection;
    fanoutConnection: Connection;
    raceConnection: Connection;

    constructor(initialTransports: TransportConfig[], config?: TransportManagerConfig) {
        this.strictPriorityMode = config?.strictPriorityMode ?? false;
        this.metricCallback = config?.metricCallback;
        this.redisClient = config?.redisClient;
        this.updateTransports(initialTransports);

        const dummyConnection = new Connection(this.transports[0].transportConfig.url);

        this.smartConnection = new Proxy(dummyConnection, {
            get: (target, prop, receiver) => {
                const originalMethod = target[prop];
                if (typeof originalMethod === 'function' && originalMethod.constructor.name === "AsyncFunction") {
                    return (...args) => {
                        return this.smartTransport(prop, ...args);
                    };
                }
                
                return Reflect.get(target, prop, receiver);
            }
        })

        this.fanoutConnection = new Proxy(dummyConnection, {
            get: (target, prop, receiver) => {
                const originalMethod = target[prop];
                if (typeof originalMethod === 'function' && originalMethod.constructor.name === "AsyncFunction") {
                    return (...args) => {
                        return this.fanout(prop, ...args);
                    };
                }
                
                return Reflect.get(target, prop, receiver);
            }
        })

        this.raceConnection = new Proxy(dummyConnection, {
            get: (target, prop, receiver) => {
                const originalMethod = target[prop];
                if (typeof originalMethod === 'function' && originalMethod.constructor.name === "AsyncFunction") {
                    return (...args) => {
                        return this.race(prop, ...args);
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

        let rateLimiterQueue = new RateLimiterQueue(rateLimiter, {
            maxQueueSize: MAX_RATE_LIMITER_QUEUE_SIZE
        });

        return {
            transportConfig: config,
            transportState: {
                errorCount: 0,
                lastErrorResetTime: Date.now(),
                disabled: false,
                disabledTime: 0,
                rateLimiterQueue,
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
        if (this.strictPriorityMode) {
            // Find and return the transport with the highest weight
            return availableTransports.reduce((max, transport) => 
                (max.transportConfig.weight > transport.transportConfig.weight) ? max : transport);
        }
            
        // Your existing weighted load balancing logic
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

    private availableTransportsForMethod(methodName){
        return this.transports.filter(t => !t.transportConfig.blacklist.includes(methodName));
    }

    private async fanout(methodName, ...args): Promise<any[]> {
        const availableTransports = this.availableTransportsForMethod(methodName);

        const transportPromises = availableTransports.map(transport => 
            this.attemptSendWithRetries(transport, methodName, ...args)
        );

        const results = await this.settleAllWithTimeout(
            transportPromises,
        );
    
        return results;
    }

    private async race(methodName, ...args): Promise<any> {
        const availableTransports = this.availableTransportsForMethod(methodName);

        const transportPromises = availableTransports.map(transport => 
            Promise.race([
                this.attemptSendWithRetries(transport, methodName, ...args),
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

    private async enqueueRequest(transport: Transport, methodName, ...args): Promise<any> {
        // Ensure that the queue exists for this transport
        if (!transport.transportState.rateLimiterQueue) {
            throw new Error("RateLimiterQueue is not initialized for this transport.");
        }

        await transport.transportState.rateLimiterQueue.removeTokens(1);

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

            throw error;
        }
    }

    private async attemptSendWithRetries(transport: Transport, methodName, ...args){
        for (let attempt = 0; attempt <= transport.transportConfig.maxRetries; attempt++) {
            try {
                return await this.enqueueRequest(transport, methodName, ...args);
            } catch (error: any) {
                // Throw error if max retry attempts has been reached
                if (attempt === transport.transportConfig.maxRetries) {
                    if (error.statusCode === 429 || (error.response && error.response.status === 429)) {
                        throw new Error("Maximum retry attempts reached for HTTP 429.");
                    } else {
                        throw error;
                    }
                }

                // Exponential backoff
                let delay = Math.min(MAX_RETRY_DELAY, BASE_RETRY_DELAY * Math.pow(2, attempt));
                await new Promise(resolve => setTimeout(resolve, delay));
            }
        }
    }

    // Smart transport function that selects a transport based on weight and checks for rate limit.
    // It includes a retry mechanism with exponential backoff for handling HTTP 429 (Too Many Requests) errors.
    async smartTransport(methodName, ...args): Promise<any[]> {
        let availableTransports = this.availableTransportsForMethod(methodName);
    
        while (availableTransports.length > 0) {
            const transport = this.selectTransport(availableTransports);
    
            if (transport.transportState.disabled){
                // Check if transport should be re-enabled after cooloff period.
                if (Date.now() - transport.transportState.disabledTime >= DISABLED_RESET_MS){
                    transport.transportState.disabled = false;
                    transport.transportState.disabledTime = 0;
                } else {
                    // If transport is still in cooloff period, cycle to next transport.
                    availableTransports = availableTransports.filter(t => t !== transport);
    
                    continue;
                }
            }

            try {
                return await this.attemptSendWithRetries(transport, methodName, ...args);
            } catch(e){
                // If failover is disabled, surface the error.
                if (!transport.transportConfig.enableFailover) {
                    throw e;
                }
            }
    
            // Remove a transport with exceeded rate limit and retry with the next available one
            availableTransports = availableTransports.filter(t => t !== transport);
        }

        let lastResortTransports = this.availableTransportsForMethod(methodName);
        if (lastResortTransports.length > 0) {
            let lastResortTransport = lastResortTransports[0];

            return this.attemptSendWithRetries(lastResortTransport, methodName, ...args);
        }
    
        // Throw error if all available transports have been tried without success
        throw new Error("No available transports for the requested method.");
    }
}