# Solana Smart RPC

Intelligent transport layer for Solana RPCs that handles load balancing, rate limit throttling, failover, fanouts, and retries. Built on top of [@solana/web3.js](https://www.npmjs.com/package/@solana/web3.js).

# Example Usage

```tsx
import { TransportManager, TransportConfig } from '@tensor-hq/smart-rpc';

let defaultTransportConfig: TransportConfig[] = [
  {
    rateLimit: 10,
    weight: 80,
    blacklist: [],
    id: "Triton",
    url: TRITON_MAINNET_P0,
    enableSmartDisable: true,
    enableFailover: true,
    maxRetries: 2,
  },
  {
    rateLimit: 50,
    weight: 20,
    blacklist: [],
    id: "Alchemy",
    url: ALCHEMY_FE_EXPOSED_P0,
    enableSmartDisable: true,
    enableFailover: true,
    maxRetries: 2,
  }
];

const transportManager = new TransportManager(defaultTransportConfig);
export const smartConnection = transportManager.smartConnection;

const resp = await smartConnection.getLatestBlockhash();
console.log(resp.blockhash.toString());
```

# Features

- Weighted load balancing
- Automated failover
- Configurable retries
- Smart disable & cooloff
- In-memory rate limit queue
- Optional pooled Redis rate limit queue
- Optional metrics (method, provider, latency, status)