[![npm][npm-image]][npm-url]
[![npm-downloads][npm-downloads-image]][npm-url]
<br />
[![code-style-prettier][code-style-prettier-image]][code-style-prettier-url]

[code-style-prettier-image]: https://img.shields.io/badge/code_style-prettier-ff69b4.svg?style=flat-square
[code-style-prettier-url]: https://github.com/prettier/prettier
[npm-downloads-image]: https://img.shields.io/npm/dm/@nftechie/smart-rpc.svg?style=flat
[npm-image]: https://img.shields.io/npm/v/@nftechie/smart-rpc.svg?style=flat
[npm-url]: https://www.npmjs.com/package/@nftechie/smart-rpc

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