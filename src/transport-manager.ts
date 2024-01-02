import { Connection } from '@solana/web3.js';

// Ideas:
// - modify weight based on "closeness" to user. For example, first ping each provider and weight by response time.
// - have default in code as a fallback in case our "remote config" doesn't load properly

export const ERROR_THRESHOLD = 20;
export const RATE_LIMIT_RESET_MS = 1000; // 1 second
const ERROR_RESET_MS = 60000; // 60 seconds
const DISABLED_RESET_MS = 60000; // 60 seconds
const BASE_RETRY_DELAY = 100; // Base delay for the first retry in milliseconds
const MAX_RETRY_DELAY = 1500; // Maximum delay in milliseconds
const TIMEOUT_MS = 10000;

export interface TransportConfig {
    rate_limit: number;
    weight: number;
    blacklist: string[];
    url: string;
    enable_smart_disable: boolean;
    enable_failover: boolean;
    max_retries: number;
}

interface TransportState {
    request_count: number;
    last_reset_time: number;
    error_count: number;
    last_error_reset_time: number;
    disabled: boolean;
    disabled_time: number;
}

export interface Transport {
    transport_config: TransportConfig;
    transport_state: TransportState;
    connection: Connection;
}

interface Metric {
    method: string;
    url: string;
    latency: number;
    status_code: number;
}

export class TransportManager {
    private transports: Transport[] = [];
    private metricsUrl: string = "";
    smartConnection: Connection;

    constructor(initialTransports: TransportConfig[]) {
        this.updateTransports(initialTransports);

        this.smartConnection = new Proxy(new Connection(this.transports[0].transport_config.url), {
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
    }

    // Updates the list of transports based on the new configuration
    updateTransports(newTransports: TransportConfig[]): void {
        this.transports = newTransports.map(config => this.createTransport(config));
    }

    updateMockTransports(newTransports: Transport[]) {
        this.transports = newTransports;
    }

    enableMetrics(url: string) {
        this.metricsUrl = url;
    }

    disableMetrics() {
        this.metricsUrl = "";
    }

    getTransports(): Transport[] {
        return this.transports;
    }

    // Creates a transport object from configuration
    private createTransport(config: TransportConfig): Transport {
        return {
            transport_config: config,
            transport_state: {
                request_count: 0,
                last_reset_time: Date.now(),
                error_count: 0,
                last_error_reset_time: Date.now(),
                disabled: false,
                disabled_time: 0,
            },
            connection: new Connection(config.url, "confirmed")
        };
    }

    private timeout<TResponse>(ms: number): Promise<TResponse> {
        return new Promise((_, reject) => {
            setTimeout(() => {
                reject(new Error(`Operation timed out after ${ms} milliseconds`));
            }, ms);
        }) as Promise<TResponse>;
    }

    async sendMetricToServer(metricName: string, metricValue: Metric) {
        if (this.metricsUrl === ""){
            return;
        }

        try {
            const response = await fetch(this.metricsUrl, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    // TODO: consider adding optional auth header
                },
                body: JSON.stringify({
                    name: metricName,
                    value: metricValue,
                    timestamp: new Date().toISOString(),
                }),
            });

            if (!response.ok) {
                throw new Error(`Error: ${response.statusText}`);
            }
        } catch (error) {
            console.error('Error sending metric:', error);
        }
    }

    // Selects a transport based on their weights
    selectTransport(availableTransports: Transport[]): Transport {
        let totalWeight = availableTransports.reduce((sum, t) => sum + t.transport_config.weight, 0);
        let randomNum = Math.random() * totalWeight;
    
        for (const transport of availableTransports) {
            randomNum -= transport.transport_config.weight;
            if (randomNum <= 0) {
                return transport;
            }
        }
    
        // Fallback to the first transport in case of rounding errors.
        return availableTransports[0];
    }

    // Resets the rate limit for a given transport
    resetRateLimit(transport: Transport) {
        const currentTime = Date.now();
        if (currentTime - transport.transport_state.last_reset_time >= RATE_LIMIT_RESET_MS) {
            transport.transport_state.request_count = 0;
            transport.transport_state.last_reset_time = currentTime;
        }
    }

    // Checks if a transport has exceeded its rate limit
    isRateLimitExceeded(transport: Transport) {
        this.resetRateLimit(transport);
    
        return transport.transport_state.request_count >= transport.transport_config.rate_limit;
    }

    // Smart transport function that selects a transport based on weight and checks for rate limit.
    // It includes a retry mechanism with exponential backoff for handling HTTP 429 (Too Many Requests) errors.
    async smartTransport(methodName, ...args) {
        let availableTransports = this.transports.filter(t => !t.transport_config.blacklist.includes(methodName));
    
        while (availableTransports.length > 0) {
            const transport = this.selectTransport(availableTransports);
    
            if (transport.transport_state.disabled){
                if (Date.now() - transport.transport_state.disabled_time >= DISABLED_RESET_MS){
                    transport.transport_state.disabled = false;
                    transport.transport_state.disabled_time = 0;
                } else {
                    availableTransports = availableTransports.filter(t => t !== transport);
    
                    continue;
                }
            }
    
            if (!this.isRateLimitExceeded(transport)) {
                for (let attempt = 0; attempt <= transport.transport_config.max_retries; attempt++) {
                    let latencyStart = Date.now();

                    try {
                        transport.transport_state.request_count++;
    
                        const result = await Promise.race([
                            transport.connection[methodName](...args),
                            this.timeout(TIMEOUT_MS)
                        ]);

                        let latencyEnd = Date.now();
                        let latency = latencyEnd - latencyStart;

                        this.sendMetricToServer('SuccessfulRequest', { 
                            method: methodName,
                            url: transport.transport_config.url,
                            latency: latency,
                            status_code: 200
                        });
    
                        return result;
                    } catch (error: any) {
                        const currentTime = Date.now();

                        let latencyEnd = currentTime;
                        let latency = latencyEnd - latencyStart;

                        this.sendMetricToServer('ErrorRequest', { 
                            method: methodName,
                            url: transport.transport_config.url,
                            latency: latency,
                            status_code: error.statusCode
                        });
    
                        // Reset error count if enough time has passed
                        if (currentTime - transport.transport_state.last_error_reset_time >= ERROR_RESET_MS) {
                            transport.transport_state.error_count = 0;
                            transport.transport_state.last_error_reset_time = currentTime;
                        }
    
                        transport.transport_state.error_count++;
    
                        // Check if the error count exceeds a certain threshold
                        if (transport.transport_state.error_count > ERROR_THRESHOLD && transport.transport_config.enable_smart_disable) {
                            transport.transport_state.disabled = true;
                            transport.transport_state.disabled_time = currentTime;
                        }
    
                        // Throw error if max retry attempts has been reached
                        if (attempt === transport.transport_config.max_retries) {
                            // If failover is enabled, break so we can try another transport
                            if (transport.transport_config.enable_failover) {
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