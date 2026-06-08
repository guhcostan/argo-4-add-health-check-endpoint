```javascript
const request = require('supertest');
const app = require('../app');
const db = require('../db');

jest.mock('../db');

describe('GET /health - Edge Case Tests', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  // 1. DB connection timeout should return 503
  test('returns 503 when database connection times out', async () => {
    db.ping.mockImplementation(() =>
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error('Connection timeout')), 5000)
      )
    );

    jest.advanceTimersByTime(5000);

    const response = await request(app).get('/health');

    expect(response.status).toBe(503);
    expect(response.body.status).toBe('degraded');
  });

  // 2. DB unreachable returns 503 with degraded status
  test('returns 503 with degraded status when DB is unreachable', async () => {
    db.ping.mockRejectedValue(new Error('ECONNREFUSED'));

    const response = await request(app).get('/health');

    expect(response.status).toBe(503);
    expect(response.body).toMatchObject({
      status: 'degraded',
    });
    expect(response.body.version).toBeDefined();
    expect(response.body.uptime_seconds).toBeDefined();
  });

  // 3. Missing VERSION environment variable
  test('handles missing VERSION environment variable gracefully', async () => {
    const originalVersion = process.env.VERSION;
    delete process.env.VERSION;

    db.ping.mockResolvedValue(true);

    const response = await request(app).get('/health');

    expect(response.status).toBe(200);
    expect(response.body.version).toBeDefined();
    expect(typeof response.body.version).toBe('string');

    process.env.VERSION = originalVersion;
  });

  // 4. Missing NODE_ENV or APP_ENV environment variable
  test('returns valid response when APP_ENV environment variable is missing', async () => {
    const originalEnv = process.env.APP_ENV;
    delete process.env.APP_ENV;

    db.ping.mockResolvedValue(true);

    const response = await request(app).get('/health');

    expect(response.status).toBe(200);
    expect(response.body.status).toBe('ok');

    process.env.APP_ENV = originalEnv;
  });

  // 5. uptime_seconds must be a non-negative integer
  test('uptime_seconds is a non-negative integer, not a float or negative', async () => {
    db.ping.mockResolvedValue(true);

    const response = await request(app).get('/health');

    expect(response.status).toBe(200);
    expect(Number.isInteger(response.body.uptime_seconds)).toBe(true);
    expect(response.body.uptime_seconds).toBeGreaterThanOrEqual(0);
  });

  // 6. uptime_seconds should not overflow or return NaN when process.uptime() is unusual
  test('uptime_seconds does not return NaN or Infinity', async () => {
    db.ping.mockResolvedValue(true);

    jest.spyOn(process, 'uptime').mockReturnValue(Number.MAX_SAFE_INTEGER);

    const response = await request(app).get('/health');

    expect(response.status).toBe(200);
    expect(response.body.uptime_seconds).not.toBeNaN();
    expect(response.body.uptime_seconds).not.toBe(Infinity);

    process.uptime.mockRestore();
  });

  // 7. Concurrent health check requests do not cause race conditions or crashes
  test('handles concurrent health check requests without errors', async () => {
    db.ping.mockResolvedValue(true);

    const concurrentRequests = Array.from({ length: 50 }, () =>
      request(app).get('/health')
    );

    const responses = await Promise.all(concurrentRequests);

    responses.forEach((response) => {
      expect(response.status).toBe(200);
      expect(response.body.status).toBe('ok');
      expect(response.body.version).toBeDefined();
      expect(response.body.uptime_seconds).toBeDefined();
    });
  });

  // 8. Response must not include sensitive internal data under any condition
  test('response body does not leak sensitive environment variables or stack traces', async () => {
    db.ping.mockRejectedValue(new Error('DB error with sensitive info: password=secret123'));

    const response = await request(app).get('/health');

    expect(response.status).toBe(503);
    const bodyString = JSON.stringify(response.body);
    expect(bodyString).not.toContain('password');
    expect(bodyString).not.toContain('secret');
    expect(bodyString).not.toContain('stack');
  });

  // 9. Method not allowed - POST to /health
  test('returns 405 or 404 when POST method is used on /health endpoint', async () => {
    const response = await request(app).post('/health');

    expect([404, 405]).toContain(response.status);
  });

  // 10. SQL/NoSQL injection attempt in query string does not affect response
  test('ignores injection payloads in query string and returns normal response', async () => {
    db.ping.mockResolvedValue(true);

    const response = await request(app)
      .get('/health')
      .query({ status: "'; DROP TABLE users; --" })
      .query({ callback: '<script>alert(1)</script>' });

    expect(response.status).toBe(200);
    expect(response.body.status).toBe('ok');
  });

  // 11. Response Content-Type must be application/json
  test('returns Content-Type application/json for health check response', async () => {
    db.ping.mockResolvedValue(true);

    const response = await request(app).get('/health');

    expect(response.headers['content-type']).toMatch(/application\/json/);
  });

  // 12. DB ping intermittently fails - flapping DB
  test('returns 503 when DB ping resolves then immediately fails within same request cycle', async () => {
    db.ping
      .mockResolvedValueOnce(true)
      .mockRejectedValueOnce(new Error('Flapping connection'));

    const [firstResponse, secondResponse] = await Promise.all([
      request(app).get('/health'),
      request(app).get('/health'),
    ]);

    expect(firstResponse.status).toBe(200);
    expect(secondResponse.status).toBe(503);
  });

  // 13. version field must be a non-empty string
  test('version field is a non-empty string and not undefined or null', async () => {
    db.ping.mockResolvedValue(true);

    const response = await request(app).get('/health');

    expect(response.status).toBe(200);
    expect(typeof response.body.version).toBe('string');
    expect(response.body.version.trim().length).toBeGreaterThan(0);
  });

  // 14. High load simulation - DB responds slowly but within threshold
  test('returns 200 when DB responds slowly but within acceptable timeout threshold', async () => {
    db.ping.mockImplementation(
      () =>
        new Promise((resolve) =>
          setTimeout(() => resolve(true), 2000)
        )
    );

    jest.useRealTimers();

    const response = await request(app).get('/health');

    expect(response.status).toBe(200);
    expect(response.body.status).toBe('ok');
  }, 10000);

  // 15. Response body has exactly the expected schema, no extra undocumented fields