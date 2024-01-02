import { TransportManager, TransportConfig, ERROR_THRESHOLD, RATE_LIMIT_RESET_MS, Transport } from '../src/transport-manager';
import { expect } from 'chai';

type RpcTransportConfig = Readonly<{
  payload: unknown;
  signal?: AbortSignal;
}>;

class HttpError extends Error {
  statusCode: number;

  constructor(statusCode: number, message: string) {
      super(message);
      this.statusCode = statusCode;
      this.name = 'HttpError';
  }
}

// Mock implementation with a generic return type
const mockIRpcTransport = async <TResponse>(config: RpcTransportConfig): Promise<TResponse> => {
  // You can define a default mock response or construct it based on `config`
  const defaultMockResponse: unknown = { data: 'Mocked response' };

  // Cast the default mock response to the generic type TResponse
  return defaultMockResponse as TResponse;
};

const mockConfig = { payload: { method: 'getLatestBlockhash' } };

const mockIRpcTransport429 = async <TResponse>(config: RpcTransportConfig): Promise<TResponse> => {
  throw new HttpError(429, "Too Many Requests");
};

const mockIRpcTransportUnexpectedError = async <TResponse>(config: RpcTransportConfig): Promise<TResponse> => {
  throw new Error("Unexpected error");
};

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
      transport: mockIRpcTransport
    }];

    const transportManager = new TransportManager([defaultTransportConfig]);
    transportManager.updateMockTransports(transports);
    
    const response = await transportManager.smartTransport(mockConfig);

    expect(response).to.deep.equal({ data: 'Mocked response' });
  });

  it('should hit max retries', async () => {
    let transports: Transport[] = [{
      transport_config: structuredClone(defaultTransportConfig),
      transport_state: structuredClone(defaultTransportState),
      transport: mockIRpcTransport429
    }];

    const transportManager = new TransportManager([defaultTransportConfig]);
    transportManager.updateMockTransports(transports);
    
    try {
        await transportManager.smartTransport(mockConfig);
        
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
      transport: mockIRpcTransport429
    }];

    const transportManager = new TransportManager([defaultTransportConfig]);
    transportManager.updateMockTransports(transports);
    
    try {
        await transportManager.smartTransport(mockConfig);
        
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
      transport: mockIRpcTransport
    }];

    const transportManager = new TransportManager([defaultTransportConfig]);
    transportManager.updateMockTransports(transports);
    
    try {
        await transportManager.smartTransport(mockConfig);
        
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
      transport: mockIRpcTransport
    }];

    const transportManager = new TransportManager([defaultTransportConfig]);
    transportManager.updateMockTransports(transports);
    
    const response = await transportManager.smartTransport(mockConfig);

    expect(response).to.deep.equal({ data: 'Mocked response' });
  });

  it('should handle unexpected transport error', async () => {
    let transports: Transport[] = [{
      transport_config: structuredClone(defaultTransportConfig),
      transport_state: structuredClone(defaultTransportState),
      transport: mockIRpcTransportUnexpectedError
    }];

    const transportManager = new TransportManager([defaultTransportConfig]);
    transportManager.updateMockTransports(transports);
    
    try {
      await transportManager.smartTransport(mockConfig);
      
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
      transport: mockIRpcTransportUnexpectedError
    }];

    const transportManager = new TransportManager([defaultTransportConfig]);
    transportManager.updateMockTransports(transports);

    for (var i = 0; i <= ERROR_THRESHOLD; i++){
      try {
        await transportManager.smartTransport(mockConfig);
        
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
      transport: mockIRpcTransportUnexpectedError
    }];

    const transportManager = new TransportManager([defaultTransportConfig]);
    transportManager.updateMockTransports(transports);
    
    try {
      await transportManager.smartTransport(mockConfig);
      
      expect.fail('Expected function to throw an unexpected error');
    } catch (error) {
      expect(error).to.be.an('error');
      expect(error.message).to.include('Unexpected error');
    }

    let updatedTransports = [{
      transport_config: structuredClone(defaultTransportConfig),
      transport_state: structuredClone(defaultTransportState),
      transport: mockIRpcTransport
    }];

    transportManager.updateMockTransports(updatedTransports);

    const response = await transportManager.smartTransport(mockConfig);

    expect(response).to.deep.equal({ data: 'Mocked response' });
  });

  it('should handle failover', async () => {
    let transports: Transport[] = [
      {
        transport_config: {
          ...structuredClone(defaultTransportConfig),
          enable_failover: true,
        },
        transport_state: structuredClone(defaultTransportState),
        transport: mockIRpcTransportUnexpectedError
      },
      {
        transport_config: {
          ...structuredClone(defaultTransportConfig),
          weight: 0,
        },
        transport_state: structuredClone(defaultTransportState),
        transport: mockIRpcTransport
      }
    ];

    const transportManager = new TransportManager([defaultTransportConfig]);
    transportManager.updateMockTransports(transports);

    const response = await transportManager.smartTransport(mockConfig);

    expect(response).to.deep.equal({ data: 'Mocked response' });
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
        transport: mockIRpcTransport
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
      transport: mockIRpcTransport
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
      transport: mockIRpcTransport
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
      transport: mockIRpcTransport
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
      transport: mockIRpcTransport
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
      transport: mockIRpcTransport
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
      transport: mockIRpcTransport
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