# Solana Smart RPC

Intelligent transport layer for Solana RPCs that handles load balancing, rate limit throttling, failover, fanouts, and retries. Built on top of [@solana/web3.js](https://www.npmjs.com/package/@solana/web3.js).

![smart rpc metrics dashboard](https://i.ibb.co/yg9rQL9/Screenshot-2024-02-06-at-12-59-53-PM.png)

# Getting Started

Smart RPC is a proxy to the existing Connection class, so migrating should be very simple. Under the hood, when you make requests, it proxies to underlying logic that determines which transport to send your request to.

```tsx
import { TransportManager, TransportConfig } from "@tensor-hq/smart-rpc";

let defaultTransportConfig: TransportConfig[] = [
  {
    rateLimit: 50,
    weight: 50,
    blacklist: [],
    id: "Triton",
    url: TRITON_MAINNET_P0,
    enableSmartDisable: true,
    enableFailover: true,
    maxRetries: 2,
  },
  {
    rateLimit: 50,
    weight: 50,
    blacklist: [],
    id: "Helius",
    url: HELIUS_FE_MAINNET_P0,
    enableSmartDisable: true,
    enableFailover: true,
    maxRetries: 2,
  },
];

const smartRpcMetricLogger: MetricCallback = (_, metricValue) => {
  console.log(metricValue);
};

let optionalConfig: TransportManagerConfig = {
  strictPriorityMode: true, // if set, will always try highest weighted provider first instead of load balancing
  metricCallback: smartRpcMetricLogger, // callback function for successful and failed requests
  queueSize: 1000, // configurable queue size for underlying rate limit queue
  timeoutMs: 5000, // configurable timeout for underlying requests
};

const transportManager = new TransportManager(defaultTransportConfig, optionalConfig);
export const smartConnection = transportManager.smartConnection;

const resp = await smartConnection.getLatestBlockhash();
console.log(resp.blockhash.toString());
```

# Connection Types

## Smart connection

This is the recommended connection for most cases. It's a drop-in replacement for the existing Connection class within built-in features such as load balancing, failover, and retries.

## Fanout connection

Sometimes you might want to send the same request to multiple connections. One example is `getLatestBlockhash`, since some RPC providers may occasionally lag behind others. When signing transacitons, fetching the most up-to-date blockhash across providers helps increase the chance your transaction will succeed. Another example is `sendTransaction`. You may want to send your transaction to multiple providers to get the fastest confirmation and increase the chance of success.

## Race connection

Assuming most providers are up-to-date, you may want to race among them to get the fastest response. For example, you could send `getAccountInfo` to multiple providers and abort after the fastest provider returns a response.

# Features

## Load Balancing

By default, Smart RPC will load balance based on the provided weights. You can configure these weights and update them at runtime (e.g. if you need a killswitch for an RPC provider).

## In-memory and Redis Rate Limiting

Smart RPC supports in-memory and pooled rate limiting. By default, rate limting will happen in-memory. If you want to pool rate limits, you can pass in an optional IORedisClient (either a single instance or cluster).

## Retries & Failover

If a particular transport has filled up its rate limit queue or encounters an error, it will automatically failover to the next transport. This makes your requests more likely to succeed if there are transient issues.

## Smart Disable

If a particular transport reaches an error threshold within a short period of time, Smart RPC will shut off requests to that transport for a short cooloff period. This can happen if you hit rate limits or if the RPC provider is having issues. Instead of spamming them, requests will be sent to a different provider.

# Known Limitations

Smart RPC doesn't support subscription endpoints, such as `onSlotUpdate`. Smart RPC is a proxy to underlying connections, and doesn't maintain long-lived connections. We recommend using the Connection class directly for subscription endpoints.
