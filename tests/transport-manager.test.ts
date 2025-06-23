import { Connection } from "@solana/web3.js";
import { expect } from "chai";
import {
  ERROR_THRESHOLD,
  MetricCallback,
  Transport,
  TransportConfig,
  TransportManager,
} from "../src/transport-manager";
import { RateLimiterMemory, RateLimiterQueue } from "rate-limiter-flexible";

class HttpError extends Error {
  statusCode: number;

  constructor(statusCode: number, message: string) {
    super(message);
    this.statusCode = statusCode;
    this.name = "HttpError";
  }
}

const MOCK_CONNECTION_ENDPOINT = "https://test.com";

const mockConnectionResponse = {
  blockhash: "mockBlockhash",
  lastValidBlockHeight: 123456,
};
const mockConnectionSlowResponse = {
  blockhash: "mockBlockhashSlow",
  lastValidBlockHeight: 123455,
};

class MockConnection extends Connection {
  async getLatestBlockhash() {
    return mockConnectionResponse;
  }
}

class MockConnectionSlow extends Connection {
  async getLatestBlockhash(): Promise<any> {
    return new Promise((resolve) => {
      setTimeout(() => {
        resolve(mockConnectionSlowResponse);
      }, 50); // 50 milliseconds delay
    });
  }
}

class MockConnectionFlaky extends Connection {
  async getLatestBlockhash(): Promise<any> {
    return new Promise((resolve, reject) => {
      const random = Math.random();

      // 50% chance to throw an error
      if (random < 0.5) {
        reject(new Error("Flaky Connection Error"));
      } else {
        resolve(mockConnectionResponse);
      }
    });
  }
}

class MockConnection429 extends Connection {
  async getLatestBlockhash() {
    throw new HttpError(429, "Too Many Requests");

    return mockConnectionResponse;
  }
}

class MockConnectionUnexpectedError extends Connection {
  async getLatestBlockhash() {
    throw new Error("Unexpected error");

    return mockConnectionResponse;
  }
}

class MockConnectionHighLatency extends Connection {
  async getLatestBlockhash(): Promise<any> {
    return new Promise((resolve) => {
      setTimeout(() => {
        resolve(mockConnectionResponse);
      }, 4000); // 4 seconds delay
    });
  }

  async getAccountInfo(): Promise<any> {
    return new Promise((resolve) => {
      setTimeout(() => {
        resolve({
          data: "mockAccountData",
          executable: false,
          lamports: 1000000,
        });
      }, 4000); // 4 seconds delay
    });
  }
}

class MockConnectionMediumLatency extends Connection {
  async getLatestBlockhash(): Promise<any> {
    return new Promise((resolve) => {
      setTimeout(() => {
        resolve(mockConnectionResponse);
      }, 100); // 100ms delay
    });
  }

  async getAccountInfo(): Promise<any> {
    return new Promise((resolve) => {
      setTimeout(() => {
        resolve({
          data: "mockAccountData",
          executable: false,
          lamports: 1000000,
        });
      }, 100);
    });
  }

  async getProgramAccounts(): Promise<any> {
    return new Promise((resolve) => {
      setTimeout(() => {
        resolve([
          { account: { data: "mockProgramAccountData" }, pubkey: "mockPubkey" },
        ]);
      }, 300);
    });
  }
}

const defaultTransportConfig: TransportConfig = {
  rateLimit: 50,
  weight: 100,
  blacklist: [],
  id: "MAINNET_BETA",
  url: "https://api.mainnet-beta.solana.com",
  enableSmartDisable: true,
  enableFailover: false,
  maxRetries: 0,
  enableLatencyCooloff: true,
};

const defaultTransportState = {
  errorCount: 0,
  lastErrorResetTime: Date.now(),
  disabled: false,
  disabledTime: 0,
  methodLatencyEWMA: {},
  lastLatencyCalculation: 0,
  cachedAverageLatency: 0,
};

describe("smartTransport Tests", () => {
  let transportManager;

  function setupTransportManager(transportsConfig, managerConfig?) {
    let transports = transportsConfig.map((config) => {
      const rateLimiter = new RateLimiterMemory({
        points: config.rateLimiterConfig.points,
        duration: config.rateLimiterConfig.duration,
      });

      return {
        transportConfig: {
          ...structuredClone(defaultTransportConfig),
          ...config.overrides,
        },
        transportState: {
          ...structuredClone(defaultTransportState),
          rateLimiterQueue: new RateLimiterQueue(rateLimiter, {
            maxQueueSize: config.rateLimiterConfig.maxQueueSize,
          }),
        },
        connection: new config.connectionType(MOCK_CONNECTION_ENDPOINT),
      };
    });

    transportManager = new TransportManager(
      [defaultTransportConfig],
      managerConfig
    );
    transportManager.updateMockTransports(transports);
  }

  it("should return the expected mock response", async () => {
    const transportsConfig = [
      {
        rateLimiterConfig: { points: 50, duration: 1, maxQueueSize: 500 },
        connectionType: MockConnection,
      },
    ];

    setupTransportManager(transportsConfig);

    const response =
      await transportManager.smartConnection.getLatestBlockhash();

    expect(response).to.deep.equal(mockConnectionResponse);
  });

  it("should return error metric", async () => {
    let statusCode: number | null | undefined = 0;

    const metricCallback: MetricCallback = (metricName, metricValue) => {
      statusCode = metricValue.statusCode as number | null | undefined;
    };

    const config = {
      ...defaultTransportConfig,
      url: "https://tensor-tensor-ec08.mainnet.rpcpool.com",
    };

    transportManager = new TransportManager([config], {
      metricCallback: metricCallback,
    });

    try {
      await transportManager.smartConnection.getLatestBlockhash();

      expect.fail("Expected function to throw a 403 error");
    } catch (error) {
      expect(error).to.be.an("error");
      expect(statusCode).to.deep.equal(403);
    }
  });

  it("should return 403 error without retries", async () => {
    const config = {
      ...defaultTransportConfig,
      url: "https://tensor-tensor-ec08.mainnet.rpcpool.com",
      maxRetries: 4,
    };

    transportManager = new TransportManager([config]);

    try {
      await transportManager.smartConnection.getLatestBlockhash();

      expect.fail("Expected function to throw a single 403 error");
    } catch (error) {
      expect(error).to.be.an("error");
      const updatedTransports = transportManager.getTransports();
      expect(updatedTransports[0].transportState.errorCount).to.equal(1);
    }
  });

  it("should hit max retries", async () => {
    const transportsConfig = [
      {
        rateLimiterConfig: { points: 50, duration: 1, maxQueueSize: 500 },
        connectionType: MockConnection429,
      },
    ];

    setupTransportManager(transportsConfig);

    try {
      await transportManager.smartConnection.getLatestBlockhash();

      expect.fail("Expected function to throw an HTTP 429 error");
    } catch (error) {
      expect(error).to.be.an("error");
      expect(error.message).to.include("429");
    }
  });

  it("should enqueue and process successfully", async () => {
    const transportsConfig = [
      {
        rateLimiterConfig: { points: 1, duration: 0.1, maxQueueSize: 500 },
        connectionType: MockConnection,
      },
    ];

    setupTransportManager(transportsConfig);

    for (var i = 0; i < 2; i++) {
      const response =
        await transportManager.smartConnection.getLatestBlockhash();
      expect(response).to.deep.equal(mockConnectionResponse);
    }
  });

  it("should timeout", async () => {
    const transports: Transport[] = [
      {
        transportConfig: {
          ...structuredClone(defaultTransportConfig),
        },
        transportState: {
          ...structuredClone(defaultTransportState),
          rateLimiterQueue: new RateLimiterQueue(
            new RateLimiterMemory({
              points: 50,
              duration: 1,
            })
          ),
        },
        connection: new MockConnectionSlow(MOCK_CONNECTION_ENDPOINT),
      },
    ];

    transportManager = new TransportManager([defaultTransportConfig], {
      timeoutMs: 1,
    });

    transportManager.updateMockTransports(transports);

    try {
      await transportManager.smartConnection.getLatestBlockhash();

      expect.fail("Expected function to throw a timeout error");
    } catch (error) {
      expect(error).to.be.an("error");
      expect(error.message).to.include(
        "Operation timed out after 1 milliseconds"
      );
    }
  });

  it("should not timeout", async () => {
    const transports: Transport[] = [
      {
        transportConfig: {
          ...structuredClone(defaultTransportConfig),
        },
        transportState: {
          ...structuredClone(defaultTransportState),
          rateLimiterQueue: new RateLimiterQueue(
            new RateLimiterMemory({
              points: 50,
              duration: 1,
            })
          ),
        },
        connection: new MockConnectionSlow(MOCK_CONNECTION_ENDPOINT),
      },
    ];

    transportManager = new TransportManager([defaultTransportConfig], {
      timeoutMs: 1000,
    });

    transportManager.updateMockTransports(transports);

    const response =
      await transportManager.smartConnection.getLatestBlockhash();
    expect(response).to.deep.equal(mockConnectionSlowResponse);
  });

  it("should exceed queue size and handle successes and failures", async () => {
    const transportsConfig = [
      {
        rateLimiterConfig: { points: 1, duration: 0.01, maxQueueSize: 9 },
        connectionType: MockConnection,
      },
    ];

    setupTransportManager(transportsConfig);

    const promises: Promise<
      Readonly<{ blockhash: string; lastValidBlockHeight: number }> | Error
    >[] = [];
    for (var i = 0; i < 20; i++) {
      promises.push(transportManager.smartConnection.getLatestBlockhash());
    }

    const results = await Promise.allSettled(promises);

    const successResponses = results.filter((r) => r.status === "fulfilled");
    const failureResponses = results.filter((r) => r.status === "rejected");

    expect(successResponses.length).to.equal(
      10,
      "Expected 10 successful responses"
    );
    expect(failureResponses.length).to.equal(
      10,
      "Expected 10 failed responses"
    );

    failureResponses.forEach((response) => {
      expect(response.reason.message).to.equal(
        "Number of requests reached it's maximum 9",
        "Error message should indicate maximum requests reached"
      );
    });
  });

  it("should exceed queue size and handle retries", async () => {
    const transportsConfig = [
      {
        overrides: { weight: 70, enableFailover: true, maxRetries: 2 },
        rateLimiterConfig: { points: 1, duration: 0.01, maxQueueSize: 9 },
        connectionType: MockConnection,
      },
    ];

    setupTransportManager(transportsConfig);

    const promises: Promise<
      Readonly<{ blockhash: string; lastValidBlockHeight: number }> | Error
    >[] = [];
    for (var i = 0; i < 20; i++) {
      promises.push(transportManager.smartConnection.getLatestBlockhash());
    }

    const results = await Promise.allSettled(promises);

    const successResponses = results.filter((r) => r.status === "fulfilled");
    const failureResponses = results.filter((r) => r.status === "rejected");

    expect(successResponses.length).to.equal(
      20,
      "Expected 20 successful responses"
    );
    expect(failureResponses.length).to.equal(0, "Expected 0 failed responses");

    failureResponses.forEach((response) => {
      expect(response.reason.message).to.equal(
        "Number of requests reached it's maximum 9",
        "Error message should indicate maximum requests reached"
      );
    });
  });

  it("should handle burst", async () => {
    const transportsConfig = [
      {
        rateLimiterConfig: { points: 25, duration: 0.01, maxQueueSize: 500 },
        connectionType: MockConnection,
      },
    ];

    setupTransportManager(transportsConfig);

    const promises: Promise<
      Readonly<{ blockhash: string; lastValidBlockHeight: number }> | Error
    >[] = [];
    for (var i = 0; i < 200; i++) {
      promises.push(transportManager.smartConnection.getLatestBlockhash());
    }

    const results = await Promise.allSettled(promises);

    const successResponses = results.filter((r) => r.status === "fulfilled");

    expect(successResponses.length).to.equal(
      200,
      "Expected 200 successful responses"
    );
  });

  it("should handle burst to multiple connections", async () => {
    const transportsConfig = [
      {
        overrides: { weight: 25 },
        rateLimiterConfig: { points: 25, duration: 0.01, maxQueueSize: 1000 },
        connectionType: MockConnection,
      },
      {
        overrides: { weight: 25, enableFailover: true, maxRetries: 1 },
        rateLimiterConfig: { points: 25, duration: 0.01, maxQueueSize: 500 },
        connectionType: MockConnectionFlaky,
      },
      {
        overrides: { weight: 25 },
        rateLimiterConfig: { points: 25, duration: 0.01, maxQueueSize: 1000 },
        connectionType: MockConnectionSlow,
      },
      {
        overrides: { weight: 25, enableFailover: true },
        rateLimiterConfig: { points: 25, duration: 0.01, maxQueueSize: 500 },
        connectionType: MockConnection429,
      },
    ];

    setupTransportManager(transportsConfig);

    const promises: Promise<
      Readonly<{ blockhash: string; lastValidBlockHeight: number }> | Error
    >[] = [];
    for (var i = 0; i < 2000; i++) {
      promises.push(transportManager.smartConnection.getLatestBlockhash());
    }

    const results = await Promise.allSettled(promises);

    const successResponses = results.filter((r) => r.status === "fulfilled");

    expect(successResponses.length).to.equal(
      2000,
      "Expected 2000 successful responses"
    );
  });

  it("should handle burst to multiple connections with last resort", async () => {
    const transportsConfig = [
      {
        overrides: { weight: 25, enableFailover: true },
        rateLimiterConfig: { points: 25, duration: 0.01, maxQueueSize: 100 },
        connectionType: MockConnection,
      },
      {
        overrides: { weight: 25, enableFailover: true },
        rateLimiterConfig: { points: 25, duration: 0.01, maxQueueSize: 100 },
        connectionType: MockConnection,
      },
    ];

    setupTransportManager(transportsConfig);

    const promises: Promise<
      Readonly<{ blockhash: string; lastValidBlockHeight: number }> | Error
    >[] = [];
    for (var i = 0; i < 2000; i++) {
      promises.push(transportManager.smartConnection.getLatestBlockhash());
    }

    const results = await Promise.allSettled(promises);

    const successResponses = results.filter((r) => r.status === "fulfilled");

    expect(successResponses.length).to.equal(
      2000,
      "Expected 2000 successful responses"
    );

    for (var i = 0; i < successResponses.length; i++) {
      expect(successResponses[i].value).to.equal(mockConnectionResponse);
    }
  });

  it("should handle burst failures", async () => {
    const transportsConfig = [
      {
        rateLimiterConfig: { points: 25, duration: 0.01, maxQueueSize: 25 },
        connectionType: MockConnection429,
      },
      {
        rateLimiterConfig: { points: 25, duration: 0.01, maxQueueSize: 25 },
        connectionType: MockConnectionUnexpectedError,
      },
    ];

    setupTransportManager(transportsConfig);

    const promises: Promise<
      Readonly<{ blockhash: string; lastValidBlockHeight: number }> | Error
    >[] = [];
    for (var i = 0; i < 1000; i++) {
      promises.push(transportManager.smartConnection.getLatestBlockhash());
    }

    const results = await Promise.allSettled(promises);

    const successResponses = results.filter((r) => r.status === "rejected");

    expect(successResponses.length).to.equal(
      1000,
      "Expected 1000 failed responses"
    );
  });

  it("should handle burst with failover", async () => {
    const transportsConfig = [
      {
        overrides: { weight: 70, enableFailover: true },
        rateLimiterConfig: { points: 25, duration: 0.01, maxQueueSize: 500 },
        connectionType: MockConnection429,
      },
      {
        overrides: { weight: 10 },
        rateLimiterConfig: { points: 25, duration: 0.01, maxQueueSize: 500 },
        connectionType: MockConnection,
      },
      {
        overrides: { weight: 20, enableFailover: true },
        rateLimiterConfig: { points: 25, duration: 0.01, maxQueueSize: 500 },
        connectionType: MockConnectionUnexpectedError,
      },
    ];

    setupTransportManager(transportsConfig);

    const promises: Promise<
      Readonly<{ blockhash: string; lastValidBlockHeight: number }> | Error
    >[] = [];
    for (var i = 0; i < 200; i++) {
      promises.push(transportManager.smartConnection.getLatestBlockhash());
    }

    const results = await Promise.allSettled(promises);

    const successResponses = results.filter((r) => r.status === "fulfilled");

    expect(successResponses.length).to.equal(
      200,
      "Expected 200 successful responses"
    );
  });

  it("should handle burst with retries", async () => {
    const transportsConfig = [
      {
        overrides: { weight: 70, enableFailover: true, maxRetries: 2 },
        rateLimiterConfig: { points: 25, duration: 0.01, maxQueueSize: 25 },
        connectionType: MockConnection429,
      },
      {
        overrides: { weight: 10, maxRetries: 2 },
        rateLimiterConfig: { points: 25, duration: 0.01, maxQueueSize: 500 },
        connectionType: MockConnection,
      },
    ];

    setupTransportManager(transportsConfig);

    const promises: Promise<
      Readonly<{ blockhash: string; lastValidBlockHeight: number }> | Error
    >[] = [];
    for (var i = 0; i < 200; i++) {
      promises.push(transportManager.smartConnection.getLatestBlockhash());
    }

    const results = await Promise.allSettled(promises);

    const successResponses = results.filter((r) => r.status === "fulfilled");

    expect(successResponses.length).to.equal(
      200,
      "Expected 200 successful responses"
    );
  });

  it("should handle flaky connection with retries", async () => {
    const transportsConfig = [
      {
        overrides: { weight: 70, maxRetries: 2 },
        rateLimiterConfig: { points: 25, duration: 0.01, maxQueueSize: 500 },
        connectionType: MockConnectionFlaky,
      },
    ];

    setupTransportManager(transportsConfig);

    const promises: Promise<
      Readonly<{ blockhash: string; lastValidBlockHeight: number }> | Error
    >[] = [];
    for (var i = 0; i < 200; i++) {
      promises.push(transportManager.smartConnection.getLatestBlockhash());
    }

    const results = await Promise.allSettled(promises);

    const successResponses = results.filter((r) => r.status === "fulfilled");

    expect(successResponses.length).to.be.greaterThanOrEqual(
      150,
      "Expected over 150 successful responses"
    );
  });

  it("should handle flaky connection with retries and failover", async () => {
    const transportsConfig = [
      {
        overrides: { weight: 70, maxRetries: 2, enableFailover: true },
        rateLimiterConfig: { points: 25, duration: 0.01, maxQueueSize: 500 },
        connectionType: MockConnectionFlaky,
      },
      {
        overrides: { weight: 30, maxRetries: 0 },
        rateLimiterConfig: { points: 25, duration: 0.01, maxQueueSize: 500 },
        connectionType: MockConnection,
      },
    ];

    setupTransportManager(transportsConfig);

    const promises: Promise<
      Readonly<{ blockhash: string; lastValidBlockHeight: number }> | Error
    >[] = [];
    for (var i = 0; i < 200; i++) {
      promises.push(transportManager.smartConnection.getLatestBlockhash());
    }

    const results = await Promise.allSettled(promises);

    const successResponses = results.filter((r) => r.status === "fulfilled");

    expect(successResponses.length).to.equal(
      200,
      "Expected 200 successful responses"
    );
  });

  it("should hit blacklisted method", async () => {
    const transportsConfig = [
      {
        overrides: { blacklist: ["getLatestBlockhash"] },
        rateLimiterConfig: { points: 1, duration: 1, maxQueueSize: 500 },
        connectionType: MockConnection,
      },
    ];

    setupTransportManager(transportsConfig);

    try {
      await transportManager.smartConnection.getLatestBlockhash();

      expect.fail("Expected function to throw a No available transports error");
    } catch (error) {
      expect(error).to.be.an("error");
      expect(error.message).to.include(
        "No available transports for the requested method."
      );
    }
  });

  it("should handle bad weight", async () => {
    const transportsConfig = [
      {
        overrides: { weight: -1 },
        rateLimiterConfig: { points: 50, duration: 1, maxQueueSize: 500 },
        connectionType: MockConnection,
      },
    ];

    setupTransportManager(transportsConfig);

    const response =
      await transportManager.smartConnection.getLatestBlockhash();

    expect(response).to.deep.equal(mockConnectionResponse);
  });

  it("should handle unexpected transport error", async () => {
    const transportsConfig = [
      {
        rateLimiterConfig: { points: 50, duration: 1, maxQueueSize: 500 },
        connectionType: MockConnectionUnexpectedError,
      },
    ];

    setupTransportManager(transportsConfig);

    try {
      await transportManager.smartConnection.getLatestBlockhash();

      expect.fail("Expected function to throw an unexpected error");
    } catch (error) {
      expect(error).to.be.an("error");
      expect(error.message).to.include("Unexpected error");
    }
  });

  it("should disable transport", async () => {
    const transportsConfig = [
      {
        rateLimiterConfig: { points: 50, duration: 1, maxQueueSize: 500 },
        connectionType: MockConnectionUnexpectedError,
      },
    ];

    setupTransportManager(transportsConfig);

    for (var i = 0; i <= ERROR_THRESHOLD; i++) {
      const updatedTransports = transportManager.getTransports();
      expect(updatedTransports[0].transportState.disabled).to.equal(false);

      try {
        await transportManager.smartConnection.getLatestBlockhash();

        expect.fail("Expected function to throw an unexpected error");
      } catch (error) {
        expect(error).to.be.an("error");
        expect(error.message).to.include("Unexpected error");
      }
    }

    const updatedTransports = transportManager.getTransports();
    expect(updatedTransports[0].transportState.disabled).to.equal(true);
  });

  it("should handle updating transports", async () => {
    const transportsConfig = [
      {
        rateLimiterConfig: { points: 50, duration: 1, maxQueueSize: 500 },
        connectionType: MockConnectionUnexpectedError,
      },
    ];

    setupTransportManager(transportsConfig);

    try {
      await transportManager.smartConnection.getLatestBlockhash();

      expect.fail("Expected function to throw an unexpected error");
    } catch (error) {
      expect(error).to.be.an("error");
      expect(error.message).to.include("Unexpected error");
    }

    let updatedTransports: Transport[] = [
      {
        transportConfig: structuredClone(defaultTransportConfig),
        transportState: {
          ...structuredClone(defaultTransportState),
          rateLimiterQueue: new RateLimiterQueue(
            new RateLimiterMemory({
              points: 50,
              duration: 1,
            }),
            { maxQueueSize: 500 }
          ),
        },
        connection: new MockConnection(MOCK_CONNECTION_ENDPOINT),
      },
    ];

    transportManager.updateMockTransports(updatedTransports);

    const response =
      await transportManager.smartConnection.getLatestBlockhash();

    expect(response).to.deep.equal(mockConnectionResponse);
  });

  it("should handle failover", async () => {
    const transportsConfig = [
      {
        overrides: { enableFailover: true },
        rateLimiterConfig: { points: 50, duration: 1, maxQueueSize: 500 },
        connectionType: MockConnectionUnexpectedError,
      },
      {
        overrides: { weight: 0 },
        rateLimiterConfig: { points: 50, duration: 1, maxQueueSize: 500 },
        connectionType: MockConnection,
      },
    ];

    setupTransportManager(transportsConfig);

    const response =
      await transportManager.smartConnection.getLatestBlockhash();
    expect(response).to.deep.equal(mockConnectionResponse);
  });

  // Fanout Tests
  it("should return multiple results", async () => {
    const transportsConfig = [
      {
        overrides: { weight: 50 },
        rateLimiterConfig: { points: 50, duration: 1, maxQueueSize: 500 },
        connectionType: MockConnection,
      },
      {
        overrides: { weight: 50, id: "TEST", url: "https://test.connection" },
        rateLimiterConfig: { points: 50, duration: 1, maxQueueSize: 500 },
        connectionType: MockConnection,
      },
    ];

    setupTransportManager(transportsConfig);

    let results = await transportManager.fanoutConnection.getLatestBlockhash();
    expect(results).to.deep.equal([
      mockConnectionResponse,
      mockConnectionResponse,
    ]);
  });

  it("should return 1 result", async () => {
    const transportsConfig = [
      {
        overrides: { weight: 50 },
        rateLimiterConfig: { points: 50, duration: 1, maxQueueSize: 500 },
        connectionType: MockConnection,
      },
      {
        overrides: { weight: 50, id: "TEST", url: "https://test.connection" },
        rateLimiterConfig: { points: 50, duration: 1, maxQueueSize: 500 },
        connectionType: MockConnection429,
      },
    ];

    setupTransportManager(transportsConfig);

    let results = await transportManager.fanoutConnection.getLatestBlockhash();
    expect(results).to.deep.equal([mockConnectionResponse]);
  });

  it("should return no results due to errors", async () => {
    const transportsConfig = [
      {
        rateLimiterConfig: { points: 50, duration: 1, maxQueueSize: 500 },
        connectionType: MockConnectionUnexpectedError,
      },
    ];

    setupTransportManager(transportsConfig);

    let results = await transportManager.fanoutConnection.getLatestBlockhash();
    expect(results).to.deep.equal([]);
  });

  it("should return no results due to rate limit", async () => {
    const transportsConfig = [
      {
        rateLimiterConfig: { points: 0, duration: 1, maxQueueSize: 500 },
        connectionType: MockConnection,
      },
    ];

    setupTransportManager(transportsConfig);

    let results = await transportManager.fanoutConnection.getLatestBlockhash();
    expect(results).to.deep.equal([]);
  });

  it("should return no results due to blacklist", async () => {
    const transportsConfig = [
      {
        overrides: { blacklist: ["getLatestBlockhash"] },
        rateLimiterConfig: { points: 50, duration: 1, maxQueueSize: 500 },
        connectionType: MockConnection,
      },
    ];

    setupTransportManager(transportsConfig);

    let results = await transportManager.fanoutConnection.getLatestBlockhash();
    expect(results).to.deep.equal([]);
  });

  // Race Tests
  it("should return faster response", async () => {
    const transportsConfig = [
      {
        overrides: { weight: 50, id: "TEST", url: "https://test.connection" },
        rateLimiterConfig: { points: 50, duration: 1, maxQueueSize: 500 },
        connectionType: MockConnectionSlow,
      },
      {
        overrides: { weight: 50 },
        rateLimiterConfig: { points: 50, duration: 1, maxQueueSize: 500 },
        connectionType: MockConnection,
      },
    ];

    setupTransportManager(transportsConfig);

    let results = await transportManager.raceConnection.getLatestBlockhash();
    expect(results).to.deep.equal(mockConnectionResponse);
  });

  it("should return response without error", async () => {
    const transportsConfig = [
      {
        overrides: { weight: 50 },
        rateLimiterConfig: { points: 50, duration: 1, maxQueueSize: 500 },
        connectionType: MockConnection429,
      },
      {
        overrides: { weight: 50, id: "TEST", url: "https://test.connection" },
        rateLimiterConfig: { points: 50, duration: 1, maxQueueSize: 500 },
        connectionType: MockConnectionSlow,
      },
    ];

    setupTransportManager(transportsConfig);

    let results = await transportManager.raceConnection.getLatestBlockhash();
    expect(results).to.deep.equal(mockConnectionSlowResponse);
  });

  it("should return all transports failed error", async () => {
    const transportsConfig = [
      {
        overrides: { weight: 50 },
        rateLimiterConfig: { points: 50, duration: 1, maxQueueSize: 500 },
        connectionType: MockConnection429,
      },
    ];

    setupTransportManager(transportsConfig);

    try {
      let results = await transportManager.raceConnection.getLatestBlockhash();

      expect.fail("Error: All transports failed or timed out");
    } catch (e) {
      expect(e).to.be.an("error");
      expect(e.message).to.include("All transports failed or timed out");
    }
  });

  it("should disable transport due to high latency", async () => {
    const transportsConfig = [
      {
        overrides: { enableLatencyCooloff: true },
        rateLimiterConfig: { points: 50, duration: 1, maxQueueSize: 500 },
        connectionType: MockConnectionHighLatency,
      },
    ];

    setupTransportManager(transportsConfig);

    // Make a few requests to build up latency metrics
    for (let i = 0; i < 2; i++) {
      try {
        await transportManager.smartConnection.getLatestBlockhash();
      } catch (error) {
        // Ignore timeouts
      }
    }

    // Check if transport was disabled
    const updatedTransports = transportManager.getTransports();
    expect(updatedTransports[0].transportState.disabled).to.equal(true);
  }).timeout(20000);

  it("should not disable transport when latency cooloff is disabled", async () => {
    const transportsConfig = [
      {
        overrides: { enableLatencyCooloff: false },
        rateLimiterConfig: { points: 50, duration: 1, maxQueueSize: 500 },
        connectionType: MockConnectionHighLatency,
      },
    ];

    setupTransportManager(transportsConfig);

    // Make a few requests to build up latency metrics
    for (let i = 0; i < 2; i++) {
      try {
        await transportManager.smartConnection.getLatestBlockhash();
      } catch (error) {
        // Ignore timeouts
      }
    }

    // Check that transport was not disabled
    const updatedTransports = transportManager.getTransports();
    expect(updatedTransports[0].transportState.disabled).to.equal(false);
  }).timeout(20000);

  it("should track latency metrics correctly", async () => {
    const transportsConfig = [
      {
        overrides: { enableLatencyCooloff: true },
        rateLimiterConfig: { points: 50, duration: 1, maxQueueSize: 500 },
        connectionType: MockConnectionHighLatency,
      },
    ];

    setupTransportManager(transportsConfig);

    // Make a request
    try {
      await transportManager.smartConnection.getLatestBlockhash();
    } catch (error) {
      // Ignore timeouts
    }

    // Check that latency metrics were recorded
    const updatedTransports = transportManager.getTransports();
    const ewmaData =
      updatedTransports[0].transportState.methodLatencyEWMA[
        "getLatestBlockhash"
      ];
    expect(ewmaData).to.not.be.undefined;
    expect(ewmaData.sampleCount).to.be.greaterThan(0);
    expect(ewmaData.ewma).to.be.greaterThan(3000);
  }).timeout(20000);

  it("should use method-specific timeout when configured", async () => {
    const transportsConfig = [
      {
        rateLimiterConfig: { points: 50, duration: 1, maxQueueSize: 500 },
        connectionType: MockConnectionSlow,
      },
    ];

    setupTransportManager(transportsConfig, {
      timeoutMs: 1000,
      methodTimeoutMs: {
        getLatestBlockhash: 25,
        getAccountInfo: 200,
      },
    });

    // Test method with short timeout (should timeout)
    try {
      await transportManager.smartConnection.getLatestBlockhash();
      expect.fail("Expected function to throw a timeout error");
    } catch (error) {
      expect(error).to.be.an("error");
      expect(error.message).to.include(
        "Operation timed out after 25 milliseconds"
      );
    }
  });

  it("should use general timeout when method-specific timeout is not configured", async () => {
    const transportsConfig = [
      {
        rateLimiterConfig: { points: 50, duration: 1, maxQueueSize: 500 },
        connectionType: MockConnectionSlow,
      },
    ];

    setupTransportManager(transportsConfig, {
      timeoutMs: 25, // General timeout: 25ms (should timeout)
      methodTimeoutMs: {
        getAccountInfo: 200, // Only getAccountInfo has method-specific timeout, not blockhash
      },
    });

    try {
      await transportManager.smartConnection.getLatestBlockhash();
      expect.fail("Expected function to throw a timeout error");
    } catch (error) {
      expect(error).to.be.an("error");
      expect(error.message).to.include(
        "Operation timed out after 25 milliseconds"
      );
    }
  });

  it("should use default timeout when neither method-specific nor general timeout is configured", async () => {
    const transportsConfig = [
      {
        rateLimiterConfig: { points: 50, duration: 1, maxQueueSize: 500 },
        connectionType: MockConnectionSlow,
      },
    ];

    setupTransportManager(transportsConfig);

    // Test method without any timeout configuration (should use default 5000ms and succeed)
    const response =
      await transportManager.smartConnection.getLatestBlockhash();
    expect(response).to.deep.equal(mockConnectionSlowResponse);
  });

  it("should prioritize method-specific timeout over general timeout", async () => {
    const transportsConfig = [
      {
        rateLimiterConfig: { points: 50, duration: 1, maxQueueSize: 500 },
        connectionType: MockConnectionSlow,
      },
    ];

    setupTransportManager(transportsConfig, {
      timeoutMs: 25, // General timeout: 25ms (would timeout)
      methodTimeoutMs: {
        getLatestBlockhash: 200, // Method-specific timeout: 200ms (should succeed)
      },
    });

    // Method-specific timeout should take precedence (200ms > 50ms delay, should succeed)
    const response =
      await transportManager.smartConnection.getLatestBlockhash();
    expect(response).to.deep.equal(mockConnectionSlowResponse);
  });

  it("should apply per-method timeouts in fanout connection", async () => {
    const transportsConfig = [
      {
        rateLimiterConfig: { points: 50, duration: 1, maxQueueSize: 500 },
        connectionType: MockConnectionSlow, // 50ms delay
      },
      {
        overrides: { id: "TEST2", url: "https://test2.connection" },
        rateLimiterConfig: { points: 50, duration: 1, maxQueueSize: 500 },
        connectionType: MockConnectionSlow, // 50ms delay
      },
    ];

    setupTransportManager(transportsConfig, {
      methodTimeoutMs: {
        getLatestBlockhash: 200,
      },
    });

    const results =
      await transportManager.fanoutConnection.getLatestBlockhash();
    expect(results).to.deep.equal([
      mockConnectionSlowResponse,
      mockConnectionSlowResponse,
    ]);
  });

  it("should apply per-method timeouts in race connection", async () => {
    const transportsConfig = [
      {
        rateLimiterConfig: { points: 50, duration: 1, maxQueueSize: 500 },
        connectionType: MockConnectionHighLatency, // 4000ms delay
      },
      {
        overrides: { id: "TEST2", url: "https://test2.connection" },
        rateLimiterConfig: { points: 50, duration: 1, maxQueueSize: 500 },
        connectionType: MockConnectionSlow, // 50ms delay
      },
    ];

    setupTransportManager(transportsConfig, {
      methodTimeoutMs: {
        getLatestBlockhash: 200,
      },
    });

    // Race should return the faster response (MockConnectionSlow)
    const result = await transportManager.raceConnection.getLatestBlockhash();
    expect(result).to.deep.equal(mockConnectionSlowResponse);
  }).timeout(10000);

  it("should handle multiple methods with different timeout configurations", async () => {
    const transportsConfig = [
      {
        rateLimiterConfig: { points: 50, duration: 1, maxQueueSize: 500 },
        connectionType: MockConnectionMediumLatency, // Various delays: 100ms for most, 300ms for getProgramAccounts
      },
    ];

    setupTransportManager(transportsConfig, {
      timeoutMs: 1000,
      methodTimeoutMs: {
        getLatestBlockhash: 50, // Should timeout (100ms delay > 50ms timeout)
        getAccountInfo: 200, // Should succeed (100ms delay < 200ms timeout)
        getProgramAccounts: 250, // Should timeout (300ms delay > 250ms timeout)
      },
    });

    // Test getLatestBlockhash - should timeout
    try {
      await transportManager.smartConnection.getLatestBlockhash();
      expect.fail("Expected getLatestBlockhash to timeout");
    } catch (error) {
      expect(error).to.be.an("error");
      expect(error.message).to.include(
        "Operation timed out after 50 milliseconds"
      );
    }

    // Test getAccountInfo - should succeed
    const accountInfo = await transportManager.smartConnection.getAccountInfo(
      "mockPublicKey"
    );
    expect(accountInfo).to.deep.equal({
      SmartRpcProvider: "MAINNET_BETA",
      data: "mockAccountData",
      executable: false,
      lamports: 1000000,
    });

    // Test getProgramAccounts - should timeout
    try {
      await transportManager.smartConnection.getProgramAccounts(
        "mockProgramId"
      );
      expect.fail("Expected getProgramAccounts to timeout");
    } catch (error) {
      expect(error).to.be.an("error");
      expect(error.message).to.include(
        "Operation timed out after 250 milliseconds"
      );
    }
  });

  it("should verify getRequestTimeoutMs returns correct values", async () => {
    // Test with full configuration
    const transportManager1 = new TransportManager([defaultTransportConfig], {
      timeoutMs: 2000,
      methodTimeoutMs: {
        getLatestBlockhash: 500,
        getAccountInfo: 1500,
      },
    });

    expect(
      transportManager1.getRequestTimeoutMs("getLatestBlockhash")
    ).to.equal(500);
    expect(transportManager1.getRequestTimeoutMs("getAccountInfo")).to.equal(
      1500
    );
    expect(
      transportManager1.getRequestTimeoutMs("getProgramAccounts")
    ).to.equal(2000); // Falls back to general timeout
    expect(transportManager1.getRequestTimeoutMs()).to.equal(2000); // No method specified, uses general timeout

    // Test with only general timeout
    const transportManager2 = new TransportManager([defaultTransportConfig], {
      timeoutMs: 3000,
    });

    expect(
      transportManager2.getRequestTimeoutMs("getLatestBlockhash")
    ).to.equal(3000);
    expect(transportManager2.getRequestTimeoutMs("getAccountInfo")).to.equal(
      3000
    );
    expect(transportManager2.getRequestTimeoutMs()).to.equal(3000);

    // Test with no timeout configuration (should use DEFAULT_TIMEOUT_MS = 5000)
    const transportManager3 = new TransportManager([defaultTransportConfig]);

    expect(
      transportManager3.getRequestTimeoutMs("getLatestBlockhash")
    ).to.equal(5000);
    expect(transportManager3.getRequestTimeoutMs("getAccountInfo")).to.equal(
      5000
    );
    expect(transportManager3.getRequestTimeoutMs()).to.equal(5000);

    // Test with only method-specific timeouts
    const transportManager4 = new TransportManager([defaultTransportConfig], {
      methodTimeoutMs: {
        getLatestBlockhash: 800,
      },
    });

    expect(
      transportManager4.getRequestTimeoutMs("getLatestBlockhash")
    ).to.equal(800);
    expect(transportManager4.getRequestTimeoutMs("getAccountInfo")).to.equal(
      5000
    ); // Falls back to default
    expect(transportManager4.getRequestTimeoutMs()).to.equal(5000); // No method specified, uses default
  });
});

describe("selectTransport Tests", () => {
  const transports: Transport[] = [
    {
      transportConfig: {
        ...structuredClone(defaultTransportConfig),
        rateLimit: 50,
        weight: 0,
      },
      transportState: {
        ...structuredClone(defaultTransportState),
        rateLimiterQueue: new RateLimiterQueue(
          new RateLimiterMemory({
            points: 50,
            duration: 1,
          })
        ),
      },
      connection: new MockConnection429(MOCK_CONNECTION_ENDPOINT),
    },
    {
      transportConfig: {
        ...structuredClone(defaultTransportConfig),
        rateLimit: 20,
        weight: 100,
      },
      transportState: {
        ...structuredClone(defaultTransportState),
        rateLimiterQueue: new RateLimiterQueue(
          new RateLimiterMemory({
            points: 50,
            duration: 1,
          })
        ),
      },
      connection: new MockConnection429(MOCK_CONNECTION_ENDPOINT),
    },
    {
      transportConfig: {
        ...structuredClone(defaultTransportConfig),
        rateLimit: 30,
        weight: 0,
      },
      transportState: {
        ...structuredClone(defaultTransportState),
        rateLimiterQueue: new RateLimiterQueue(
          new RateLimiterMemory({
            points: 50,
            duration: 1,
          })
        ),
      },
      connection: new MockConnection429(MOCK_CONNECTION_ENDPOINT),
    },
  ];

  it("should always return a transport object", () => {
    const transportManager = new TransportManager([defaultTransportConfig]);
    const selected = transportManager.selectTransport(transports);
    expect(selected).to.be.an("object");
  });

  it("should return the second transport", () => {
    const transportManager = new TransportManager([defaultTransportConfig]);
    const selected = transportManager.selectTransport(transports);
    expect(selected).to.equal(transports[1]);
  });

  it("should return the third transport", () => {
    transports[1].transportConfig.weight = 0;
    transports[2].transportConfig.weight = 100;

    const transportManager = new TransportManager([defaultTransportConfig]);
    const selected = transportManager.selectTransport(transports);
    expect(selected).to.equal(transports[2]);
  });

  it("should handle strict priority mode", () => {
    transports[0].transportConfig.weight = 25;
    transports[1].transportConfig.weight = 60;
    transports[2].transportConfig.weight = 15;

    const transportManager = new TransportManager([defaultTransportConfig], {
      strictPriorityMode: true,
    });

    for (var i = 0; i < 100; i++) {
      const selected = transportManager.selectTransport(transports);
      expect(selected).to.equal(transports[1]);
    }
  });
});
