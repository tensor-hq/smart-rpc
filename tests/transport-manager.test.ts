import { Connection } from '@solana/web3.js';
import { expect } from 'chai';
import { ERROR_THRESHOLD, Transport, TransportConfig, TransportManager } from '../src/transport-manager';
import { RateLimiterMemory, RateLimiterQueue } from 'rate-limiter-flexible';

class HttpError extends Error {
  statusCode: number;

  constructor(statusCode: number, message: string) {
      super(message);
      this.statusCode = statusCode;
      this.name = 'HttpError';
  }
}

const MOCK_CONNECTION_ENDPOINT = "https://test.com";

const mockConnectionResponse = { blockhash: 'mockBlockhash', lastValidBlockHeight: 123456 };
const mockConnectionSlowResponse = { blockhash: 'mockBlockhashSlow', lastValidBlockHeight: 123455 };

class MockConnection extends Connection {
  // Mock for getLatestBlockhash method
  async getLatestBlockhash() {
      return mockConnectionResponse;
  }
}

class MockConnectionSlow extends Connection {
  // Mock for getLatestBlockhash method
  async getLatestBlockhash(): Promise<any> {
    return new Promise(resolve => {
        setTimeout(() => {
            resolve(mockConnectionSlowResponse);
        }, 50); // 50 milliseconds delay
    });
}
}

class MockConnection429 extends Connection {
  // Mock for getLatestBlockhash method
  async getLatestBlockhash() {
    throw new HttpError(429, "Too Many Requests");

    return mockConnectionResponse;
  }
}

class MockConnectionUnexpectedError extends Connection {
  // Mock for getLatestBlockhash method
  async getLatestBlockhash() {
    throw new Error("Unexpected error");

    return mockConnectionResponse;
  }
}

const defaultTransportConfig: TransportConfig = {
  rateLimit: 50,
  weight: 100,
  blacklist: [],
  id: 'MAINNET_BETA',
  url: 'https://api.mainnet-beta.solana.com',
  enableSmartDisable: true,
  enableFailover: false,
  maxRetries: 0,
}

const defaultTransportState = {
  errorCount: 0,
  lastErrorResetTime: Date.now(),
  disabled: false,
  disabledTime: 0,
}

describe('smartTransport Tests', () => {
  let transportManager;

  function setupTransportManager(transportsConfig) {
    let transports = transportsConfig.map(config => {
      const rateLimiter = new RateLimiterMemory({
          points: config.rateLimiterConfig.points,
          duration: config.rateLimiterConfig.duration,
      });

      return {
          transportConfig: { ...structuredClone(defaultTransportConfig), ...config.overrides },
          transportState: {
              ...structuredClone(defaultTransportState),
              rateLimiterQueue: new RateLimiterQueue(rateLimiter, {
                  maxQueueSize: config.rateLimiterConfig.maxQueueSize
              })
          },
          connection: new config.connectionType(MOCK_CONNECTION_ENDPOINT)
      };
    });

    transportManager = new TransportManager([defaultTransportConfig]);
    transportManager.updateMockTransports(transports);
  }

  it('should return the expected mock response', async () => {
    const transportsConfig = [
      {
        rateLimiterConfig: { points: 50, duration: 1, maxQueueSize: 500 },
        connectionType: MockConnection
      }
    ];

    setupTransportManager(transportsConfig);
    
    const response = await transportManager.smartConnection.getLatestBlockhash();

    expect(response).to.deep.equal(mockConnectionResponse);
  });

  it('should hit max retries', async () => {
    const transportsConfig = [
      {
        rateLimiterConfig: { points: 50, duration: 1, maxQueueSize: 500 },
        connectionType: MockConnection429
      }
    ];

    setupTransportManager(transportsConfig);
    
    try {
        await transportManager.smartConnection.getLatestBlockhash();
        
        expect.fail('Expected function to throw an HTTP 429 error');
    } catch (error) {
        expect(error).to.be.an('error');
        expect(error.message).to.include('429');
    }
  });

  it('should enqueue and process successfully', async () => {
    const transportsConfig = [
      {
        rateLimiterConfig: { points: 1, duration: 0.1, maxQueueSize: 500 },
        connectionType: MockConnection
      }
    ];

    setupTransportManager(transportsConfig);

    for (var i = 0; i < 2; i++){
      const response = await transportManager.smartConnection.getLatestBlockhash();
      expect(response).to.deep.equal(mockConnectionResponse);
    }
  });

  it('should exceed queue size and handle successes and failures', async () => {
    const transportsConfig = [
      {
        rateLimiterConfig: { points: 1, duration: 0.01, maxQueueSize: 9 },
        connectionType: MockConnection
      }
    ];

    setupTransportManager(transportsConfig);

    const promises: Promise<Readonly<{ blockhash: string; lastValidBlockHeight: number; }> | Error>[] = [];
    for (var i = 0; i < 20; i++) {
      promises.push(transportManager.smartConnection.getLatestBlockhash());
    }

    const results = await Promise.allSettled(promises);

    const successResponses = results.filter(r => r.status === 'fulfilled');
    const failureResponses = results.filter(r => r.status === 'rejected');

    expect(successResponses.length).to.equal(10, 'Expected 10 successful responses');
    expect(failureResponses.length).to.equal(10, 'Expected 10 failed responses');

    failureResponses.forEach(response => {
      expect(response.reason.message).to.equal("Number of requests reached it's maximum 9", 'Error message should indicate maximum requests reached');
    });
  });

  it('should handle burst', async () => {
    const transportsConfig = [
      {
        rateLimiterConfig: { points: 25, duration: 0.01, maxQueueSize: 500 },
        connectionType: MockConnection
      }
    ];

    setupTransportManager(transportsConfig);

    const promises: Promise<Readonly<{ blockhash: string; lastValidBlockHeight: number; }> | Error>[] = [];
    for (var i = 0; i < 200; i++) {
      promises.push(transportManager.smartConnection.getLatestBlockhash());
    }

    const results = await Promise.allSettled(promises);

    const successResponses = results.filter(r => r.status === 'fulfilled');

    expect(successResponses.length).to.equal(200, 'Expected 200 successful responses');
  });

  it('should hit blacklisted method', async () => {
    const transportsConfig = [
      {
        overrides: { blacklist: ['getLatestBlockhash'] },
        rateLimiterConfig: { points: 1, duration: 1, maxQueueSize: 500 },
        connectionType: MockConnection
      }
    ];

    setupTransportManager(transportsConfig);
    
    try {
      await transportManager.smartConnection.getLatestBlockhash();
      
      expect.fail('Expected function to throw a No available transports error');
    } catch (error) {
        expect(error).to.be.an('error');
        expect(error.message).to.include('No available transports for the requested method.');
    }
  });

  it('should handle bad weight', async () => {
    const transportsConfig = [
      {
        overrides: { weight: -1 },
        rateLimiterConfig: { points: 50, duration: 1, maxQueueSize: 500 },
        connectionType: MockConnection
      }
    ];

    setupTransportManager(transportsConfig);
    
    const response = await transportManager.smartConnection.getLatestBlockhash();

    expect(response).to.deep.equal(mockConnectionResponse);
  });

  it('should handle unexpected transport error', async () => {
    const transportsConfig = [
      {
        rateLimiterConfig: { points: 50, duration: 1, maxQueueSize: 500 },
        connectionType: MockConnectionUnexpectedError
      }
    ];

    setupTransportManager(transportsConfig);
    
    try {
      await transportManager.smartConnection.getLatestBlockhash();
      
      expect.fail('Expected function to throw an unexpected error');
    } catch (error) {
      expect(error).to.be.an('error');
      expect(error.message).to.include('Unexpected error');
    }
  });

  it('should disable transport', async () => {
    const transportsConfig = [
      {
        rateLimiterConfig: { points: 50, duration: 1, maxQueueSize: 500 },
        connectionType: MockConnectionUnexpectedError
      }
    ];

    setupTransportManager(transportsConfig);

    for (var i = 0; i <= ERROR_THRESHOLD; i++){
      const updatedTransports = transportManager.getTransports();
      expect(updatedTransports[0].transportState.disabled).to.equal(false);

      try {
        await transportManager.smartConnection.getLatestBlockhash();
        
        expect.fail('Expected function to throw an unexpected error');
      } catch (error) {
        expect(error).to.be.an('error');
        expect(error.message).to.include('Unexpected error');
      }
    }

    const updatedTransports = transportManager.getTransports();
    expect(updatedTransports[0].transportState.disabled).to.equal(true);
  });

  it('should handle updating transports', async () => {
    const transportsConfig = [
      {
        rateLimiterConfig: { points: 50, duration: 1, maxQueueSize: 500 },
        connectionType: MockConnectionUnexpectedError
      }
    ];

    setupTransportManager(transportsConfig);
    
    try {
      await transportManager.smartConnection.getLatestBlockhash();
      
      expect.fail('Expected function to throw an unexpected error');
    } catch (error) {
      expect(error).to.be.an('error');
      expect(error.message).to.include('Unexpected error');
    }

    let updatedTransports: Transport[] = [{
      transportConfig: structuredClone(defaultTransportConfig),
      transportState: {
        ...structuredClone(defaultTransportState),
        rateLimiterQueue: new RateLimiterQueue(new RateLimiterMemory({
          points: 50,
          duration: 1,
        }), {maxQueueSize: 500})
      },
      connection: new MockConnection(MOCK_CONNECTION_ENDPOINT)
    }];

    transportManager.updateMockTransports(updatedTransports);

    const response = await transportManager.smartConnection.getLatestBlockhash();

    expect(response).to.deep.equal(mockConnectionResponse);
  });

  it('should handle failover', async () => {
    const transportsConfig = [
      {
        overrides: { enableFailover: true },
        rateLimiterConfig: { points: 50, duration: 1, maxQueueSize: 500 },
        connectionType: MockConnectionUnexpectedError
      },
      {
        overrides: { weight: 0 },
        rateLimiterConfig: { points: 50, duration: 1, maxQueueSize: 500 },
        connectionType: MockConnection
      }
    ];

    setupTransportManager(transportsConfig);

    const response = await transportManager.smartConnection.getLatestBlockhash();
    expect(response).to.deep.equal(mockConnectionResponse);
  });

  // Fanout Tests
  it('should return multiple results', async () => {
    const transportsConfig = [
      {
        overrides: { weight: 50 },
        rateLimiterConfig: { points: 50, duration: 1, maxQueueSize: 500 },
        connectionType: MockConnection
      },
      {
        overrides: { weight: 50, id: "TEST", url: "https://test.connection" },
        rateLimiterConfig: { points: 50, duration: 1, maxQueueSize: 500 },
        connectionType: MockConnection
      }
    ];

    setupTransportManager(transportsConfig);

    let results = await transportManager.fanoutConnection.getLatestBlockhash();
    expect(results).to.deep.equal([mockConnectionResponse,mockConnectionResponse]);
  });

  it('should return 1 result', async () => {
    const transportsConfig = [
      {
        overrides: { weight: 50 },
        rateLimiterConfig: { points: 50, duration: 1, maxQueueSize: 500 },
        connectionType: MockConnection
      },
      {
        overrides: { weight: 50, id: "TEST", url: "https://test.connection" },
        rateLimiterConfig: { points: 50, duration: 1, maxQueueSize: 500 },
        connectionType: MockConnection429
      }
    ];

    setupTransportManager(transportsConfig);

    let results = await transportManager.fanoutConnection.getLatestBlockhash();
    expect(results).to.deep.equal([mockConnectionResponse]);
  });

  it('should return no results due to errors', async () => {
    const transportsConfig = [
      {
        rateLimiterConfig: { points: 50, duration: 1, maxQueueSize: 500 },
        connectionType: MockConnectionUnexpectedError
      }
    ];

    setupTransportManager(transportsConfig);

    let results = await transportManager.fanoutConnection.getLatestBlockhash();
    expect(results).to.deep.equal([]);
  });

  it('should return no results due to rate limit', async () => {
    const transportsConfig = [
      {
        rateLimiterConfig: { points: 0, duration: 1, maxQueueSize: 500 },
        connectionType: MockConnection
      }
    ];

    setupTransportManager(transportsConfig);

    let results = await transportManager.fanoutConnection.getLatestBlockhash();
    expect(results).to.deep.equal([]);
  });

  it('should return no results due to blacklist', async () => {
    const transportsConfig = [
      {
        overrides: { blacklist: ["getLatestBlockhash"] },
        rateLimiterConfig: { points: 50, duration: 1, maxQueueSize: 500 },
        connectionType: MockConnection
      }
    ];

    setupTransportManager(transportsConfig);

    let results = await transportManager.fanoutConnection.getLatestBlockhash();
    expect(results).to.deep.equal([]);
  });

  // Race Tests
  it('should return faster response', async () => {
    const transportsConfig = [
      {
        overrides: { weight: 50, id: "TEST", url: "https://test.connection" },
        rateLimiterConfig: { points: 50, duration: 1, maxQueueSize: 500 },
        connectionType: MockConnectionSlow
      },
      {
        overrides: { weight: 50 },
        rateLimiterConfig: { points: 50, duration: 1, maxQueueSize: 500 },
        connectionType: MockConnection
      }
    ];

    setupTransportManager(transportsConfig);

    let results = await transportManager.raceConnection.getLatestBlockhash();
    expect(results).to.deep.equal(mockConnectionResponse);
  });

  it('should return response without error', async () => {
    const transportsConfig = [
      {
        overrides: { weight: 50 },
        rateLimiterConfig: { points: 50, duration: 1, maxQueueSize: 500 },
        connectionType: MockConnection429
      },
      {
        overrides: { weight: 50, id: "TEST", url: "https://test.connection" },
        rateLimiterConfig: { points: 50, duration: 1, maxQueueSize: 500 },
        connectionType: MockConnectionSlow
      }
    ];

    setupTransportManager(transportsConfig);

    let results = await transportManager.raceConnection.getLatestBlockhash();
    expect(results).to.deep.equal(mockConnectionSlowResponse);
  });

  it('should return all transports failed error', async () => {
    const transportsConfig = [
      {
        overrides: { weight: 50 },
        rateLimiterConfig: { points: 50, duration: 1, maxQueueSize: 500 },
        connectionType: MockConnection429
      }
    ];

    setupTransportManager(transportsConfig);

    try {
      let results = await transportManager.raceConnection.getLatestBlockhash();
      
      expect.fail('Error: All transports failed or timed out');
    } catch(e){
      expect(e).to.be.an('error');
      expect(e.message).to.include('All transports failed or timed out');
    }
  });
});

describe('selectTransport Tests', () => {
  const transports: Transport[] = [
    {
      transportConfig: {
        ...structuredClone(defaultTransportConfig),
        rateLimit: 50, 
        weight: 0
      },
      transportState: {
        ...structuredClone(defaultTransportState),
        rateLimiterQueue: new RateLimiterQueue(new RateLimiterMemory({
          points: 50,
          duration: 1,
        }))
      },
      connection: new MockConnection429(MOCK_CONNECTION_ENDPOINT)
    },
    {
      transportConfig: {
        ...structuredClone(defaultTransportConfig),
        rateLimit: 20, 
        weight: 100 
      },
      transportState: {
        ...structuredClone(defaultTransportState),
        rateLimiterQueue: new RateLimiterQueue(new RateLimiterMemory({
          points: 50,
          duration: 1,
        }))
      },
      connection: new MockConnection429(MOCK_CONNECTION_ENDPOINT)
    },
    {
      transportConfig: {
        ...structuredClone(defaultTransportConfig),
        rateLimit: 30, 
        weight: 0 
      },
      transportState: {
        ...structuredClone(defaultTransportState),
        rateLimiterQueue: new RateLimiterQueue(new RateLimiterMemory({
          points: 50,
          duration: 1,
        }))
      },
      connection: new MockConnection429(MOCK_CONNECTION_ENDPOINT)
    },
  ];

  it('should always return a transport object', () => {
    const transportManager = new TransportManager([defaultTransportConfig]);
    const selected = transportManager.selectTransport(transports);
    expect(selected).to.be.an('object');
  });

  it('should return the second transport', () => {
    const transportManager = new TransportManager([defaultTransportConfig]);
    const selected = transportManager.selectTransport(transports);
    expect(selected).to.equal(transports[1]);
  });

  it('should return the third transport', () => {
    // Update weights
    transports[1].transportConfig.weight = 0;
    transports[2].transportConfig.weight = 100;
    
    const transportManager = new TransportManager([defaultTransportConfig]);
    const selected = transportManager.selectTransport(transports);
    expect(selected).to.equal(transports[2]);
  });
});