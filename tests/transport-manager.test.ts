import { Connection } from '@solana/web3.js';
import { expect } from 'chai';
import { ERROR_THRESHOLD, RATE_LIMIT_RESET_MS, Transport, TransportConfig, TransportManager } from '../src/transport-manager';

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

class MockConnection extends Connection {
  // Mock for getLatestBlockhash method
  async getLatestBlockhash() {
      return mockConnectionResponse;
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
  rate_limit: 50,
  weight: 100,
  blacklist: [],
  url: 'https://api.mainnet-beta.solana.com',
  enable_smart_disable: true,
  enable_failover: false,
  max_retries: 0,
}

const defaultTransportState = {
  request_count: 0,
  last_reset_time: Date.now(),
  error_count: 0,
  last_error_reset_time: Date.now(),
  disabled: false,
  disabled_time: 0,
}

describe('smartTransport Tests', () => {
  it('should return the expected mock response', async () => {
    let transports: Transport[] = [{
      transport_config: structuredClone(defaultTransportConfig),
      transport_state: structuredClone(defaultTransportState),
      connection: new MockConnection(MOCK_CONNECTION_ENDPOINT)
    }];

    const transportManager = new TransportManager([defaultTransportConfig]);
    transportManager.updateMockTransports(transports);
    
    const response = await transportManager.smartConnection.getLatestBlockhash();

    expect(response).to.deep.equal(mockConnectionResponse);
  });

  it('should hit max retries', async () => {
    let transports: Transport[] = [{
      transport_config: structuredClone(defaultTransportConfig),
      transport_state: structuredClone(defaultTransportState),
      connection: new MockConnection429(MOCK_CONNECTION_ENDPOINT)
    }];

    const transportManager = new TransportManager([defaultTransportConfig]);
    transportManager.updateMockTransports(transports);
    
    try {
        await transportManager.smartConnection.getLatestBlockhash();
        
        expect.fail('Expected function to throw an HTTP 429 error');
    } catch (error) {
        expect(error).to.be.an('error');
        expect(error.message).to.include('429');
    }
  });

  it('should exceed rate limit', async () => {
    let transports: Transport[] = [{
      transport_config: structuredClone(defaultTransportConfig),
      transport_state: {
        ...structuredClone(defaultTransportState),
        request_count: 50,
      },
      connection: new MockConnection429(MOCK_CONNECTION_ENDPOINT)
    }];

    const transportManager = new TransportManager([defaultTransportConfig]);
    transportManager.updateMockTransports(transports);
    
    try {
        await transportManager.smartConnection.getLatestBlockhash();
        
        expect.fail('Expected function to throw a transport unavailable method');
    } catch (error) {
        expect(error).to.be.an('error');
        expect(error.message).to.include('No available transports for the requested method.');
    }
  });

  it('should hit blacklisted method', async () => {
    let transports: Transport[] = [{
      transport_config: {
        ...structuredClone(defaultTransportConfig),
        blacklist: ['getLatestBlockhash']
      },
      transport_state: structuredClone(defaultTransportState),
      connection: new MockConnection(MOCK_CONNECTION_ENDPOINT)
    }];

    const transportManager = new TransportManager([defaultTransportConfig]);
    transportManager.updateMockTransports(transports);
    
    try {
        await transportManager.smartConnection.getLatestBlockhash();
        
        expect.fail('Expected function to throw a transport unavailable method');
    } catch (error) {
        expect(error).to.be.an('error');
        expect(error.message).to.include('No available transports for the requested method.');
    }
  });

  it('should handle bad weight', async () => {
    let transports: Transport[] = [{
      transport_config: {
        ...structuredClone(defaultTransportConfig),
        weight: -1,
      },
      transport_state: structuredClone(defaultTransportState),
      connection: new MockConnection(MOCK_CONNECTION_ENDPOINT)
    }];

    const transportManager = new TransportManager([defaultTransportConfig]);
    transportManager.updateMockTransports(transports);
    
    const response = await transportManager.smartConnection.getLatestBlockhash();

    expect(response).to.deep.equal(mockConnectionResponse);
  });

  it('should handle unexpected transport error', async () => {
    let transports: Transport[] = [{
      transport_config: structuredClone(defaultTransportConfig),
      transport_state: structuredClone(defaultTransportState),
      connection: new MockConnectionUnexpectedError(MOCK_CONNECTION_ENDPOINT)
    }];

    const transportManager = new TransportManager([defaultTransportConfig]);
    transportManager.updateMockTransports(transports);
    
    try {
      await transportManager.smartConnection.getLatestBlockhash();
      
      expect.fail('Expected function to throw an unexpected error');
    } catch (error) {
      expect(error).to.be.an('error');
      expect(error.message).to.include('Unexpected error');
    }
  });

  it('should disable transport', async () => {
    let transports: Transport[] = [{
      transport_config: structuredClone(defaultTransportConfig),
      transport_state: structuredClone(defaultTransportState),
      connection: new MockConnectionUnexpectedError(MOCK_CONNECTION_ENDPOINT)
    }];

    const transportManager = new TransportManager([defaultTransportConfig]);
    transportManager.updateMockTransports(transports);

    for (var i = 0; i <= ERROR_THRESHOLD; i++){
      try {
        await transportManager.smartConnection.getLatestBlockhash();
        
        expect.fail('Expected function to throw an unexpected error');
      } catch (error) {
        expect(error).to.be.an('error');
        expect(error.message).to.include('Unexpected error');
      }
    }

    const updatedTransports = transportManager.getTransports();
    expect(updatedTransports[0].transport_state.disabled).to.equal(true);
  });

  it('should handle updating transports', async () => {
    let transports: Transport[] = [{
      transport_config: structuredClone(defaultTransportConfig),
      transport_state: structuredClone(defaultTransportState),
      connection: new MockConnectionUnexpectedError(MOCK_CONNECTION_ENDPOINT)
    }];

    const transportManager = new TransportManager([defaultTransportConfig]);
    transportManager.updateMockTransports(transports);
    
    try {
      await transportManager.smartConnection.getLatestBlockhash();
      
      expect.fail('Expected function to throw an unexpected error');
    } catch (error) {
      expect(error).to.be.an('error');
      expect(error.message).to.include('Unexpected error');
    }

    let updatedTransports = [{
      transport_config: structuredClone(defaultTransportConfig),
      transport_state: structuredClone(defaultTransportState),
      connection: new MockConnection(MOCK_CONNECTION_ENDPOINT)
    }];

    transportManager.updateMockTransports(updatedTransports);

    const response = await transportManager.smartConnection.getLatestBlockhash();

    expect(response).to.deep.equal(mockConnectionResponse);
  });

  it('should handle failover', async () => {
    let transports: Transport[] = [
      {
        transport_config: {
          ...structuredClone(defaultTransportConfig),
          enable_failover: true,
        },
        transport_state: structuredClone(defaultTransportState),
        connection: new MockConnectionUnexpectedError(MOCK_CONNECTION_ENDPOINT)
      },
      {
        transport_config: {
          ...structuredClone(defaultTransportConfig),
          weight: 0,
        },
        transport_state: structuredClone(defaultTransportState),
        connection: new MockConnection(MOCK_CONNECTION_ENDPOINT)
      }
    ];

    const transportManager = new TransportManager([defaultTransportConfig]);
    transportManager.updateMockTransports(transports);

    const response = await transportManager.smartConnection.getLatestBlockhash();

    expect(response).to.deep.equal(mockConnectionResponse);
  });
});

describe('resetRateLimit Tests', () => {
  it('should reset the request count and last reset time', () => {
      const transport: Transport = {
        transport_config: {
          ...structuredClone(defaultTransportConfig),
          rate_limit: 50, 
          weight: 10 
        },
        transport_state: {
          ...structuredClone(defaultTransportState),
          request_count: 5, 
          last_reset_time: Date.now() - RATE_LIMIT_RESET_MS - 1, 
        },
        connection: new MockConnection429(MOCK_CONNECTION_ENDPOINT)
      }

      const transportManager = new TransportManager([defaultTransportConfig]);
      transportManager.resetRateLimit(transport);
      expect(transport.transport_state.request_count).to.equal(0);
      expect(transport.transport_state.last_reset_time).to.be.closeTo(Date.now(), 1000);
  });

  it('should not reset the request count and last reset time', () => {
    const transport: Transport = {
      transport_config: {
        ...structuredClone(defaultTransportConfig),
        rate_limit: 50, 
        weight: 10 
      },
      transport_state: {
        ...structuredClone(defaultTransportState),
        request_count: 5, 
        last_reset_time: Date.now() - (RATE_LIMIT_RESET_MS / 2), 
      },
      connection: new MockConnection429(MOCK_CONNECTION_ENDPOINT)
    }

    const transportManager = new TransportManager([defaultTransportConfig]);
    transportManager.resetRateLimit(transport);
    expect(transport.transport_state.request_count).to.equal(5);
  });
});

describe('isRateLimitExceeded Tests', () => {
  it('should return true if rate limit is exceeded', () => {
    const transport: Transport = {
      transport_config: {
        ...structuredClone(defaultTransportConfig),
        rate_limit: 20, 
        weight: 20 
      },
      transport_state: {
        ...structuredClone(defaultTransportState),
        request_count: 21, 
        last_reset_time: Date.now(), 
      },
      connection: new MockConnection429(MOCK_CONNECTION_ENDPOINT)
    }

    const transportManager = new TransportManager([defaultTransportConfig]);
    expect(transportManager.isRateLimitExceeded(transport)).to.be.true;
  });

  it('should return false if rate limit is not exceeded', () => {
    const transport: Transport = {
      transport_config: {
        ...structuredClone(defaultTransportConfig),
        rate_limit: 30, 
        weight: 30 
      },
      transport_state: {
        ...structuredClone(defaultTransportState),
        request_count: 15, 
        last_reset_time: Date.now(), 
      },
      connection: new MockConnection429(MOCK_CONNECTION_ENDPOINT)
    }

    const transportManager = new TransportManager([defaultTransportConfig]);
    expect(transportManager.isRateLimitExceeded(transport)).to.be.false;
  });
});

describe('selectTransport Tests', () => {
  const transports: Transport[] = [
    {
      transport_config: {
        ...structuredClone(defaultTransportConfig),
        rate_limit: 50, 
        weight: 0 
      },
      transport_state: {
        ...structuredClone(defaultTransportState),
        request_count: 0, 
        last_reset_time: Date.now() - RATE_LIMIT_RESET_MS - 1, 
      },
      connection: new MockConnection429(MOCK_CONNECTION_ENDPOINT)
    },
    {
      transport_config: {
        ...structuredClone(defaultTransportConfig),
        rate_limit: 20, 
        weight: 100 
      },
      transport_state: {
        ...structuredClone(defaultTransportState),
        request_count: 21, 
        last_reset_time: Date.now(), 
      },
      connection: new MockConnection429(MOCK_CONNECTION_ENDPOINT)
    },
    {
      transport_config: {
        ...structuredClone(defaultTransportConfig),
        rate_limit: 30, 
        weight: 0 
      },
      transport_state: {
        ...structuredClone(defaultTransportState),
        request_count: 15, 
        last_reset_time: Date.now(), 
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
    transports[1].transport_config.weight = 0;
    transports[2].transport_config.weight = 100;
    
    const transportManager = new TransportManager([defaultTransportConfig]);
    const selected = transportManager.selectTransport(transports);
    expect(selected).to.equal(transports[2]);
  });
});