import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

describe('Google OAuth Configuration', () => {
  let originalEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    originalEnv = { ...process.env };
    // Clear out google envs for the test by setting them to empty string
    // This prevents dotenv.config() from reloading them from the .env file
    process.env.GOOGLE_CLIENT_ID = '';
    process.env.GOOGLE_CLIENT_SECRET = '';
    process.env.GOOGLE_REFRESH_TOKEN = '';
    process.env.GOOGLE_CALENDAR_ID = '';
    // We need to bust the require cache to reload the config module
    delete require.cache[require.resolve('../config/index.js')];
    delete require.cache[require.resolve('../config/index.ts')];
  });

  afterEach(() => {
    process.env = originalEnv;
    delete require.cache[require.resolve('../config/index.js')];
    delete require.cache[require.resolve('../config/index.ts')];
  });

  const loadConfig = () => {
    // We must require dynamically to let it parse process.env again
    // In ESM, this is tricky. Wait, the tests are run with tsx, so we can use dynamic import?
    // Let's just redefine a loadConfig function here to simulate it if dynamic import is hard in CJS/ESM.
    // Actually, dynamic import is asynchronous.
    return import('../config/index.js?bust=' + Date.now());
  };

  it('no Google OAuth configuration leaves the optional source disabled', async () => {
    const { config } = await loadConfig();
    assert.equal(config.googleOAuthClient, null);
  });

  it('partial Google OAuth configuration fails explicitly', async () => {
    process.env.GOOGLE_CLIENT_ID = 'id';
    process.env.GOOGLE_CLIENT_SECRET = 'secret';
    // Missing refresh token and calendar ID
    await assert.rejects(
      async () => {
        await loadConfig();
      },
      (err: Error) => err.message.includes('Google Calendar configuration is incomplete')
    );
  });

  it('complete Google OAuth environment configuration creates the OAuth client', async () => {
    process.env.GOOGLE_CLIENT_ID = 'id';
    process.env.GOOGLE_CLIENT_SECRET = 'secret';
    process.env.GOOGLE_REFRESH_TOKEN = 'refresh';
    process.env.GOOGLE_CALENDAR_ID = 'calendar@group.calendar.google.com';

    const { config } = await loadConfig();
    assert.ok(config.googleOAuthClient);
    assert.equal(config.googleCalendarId, 'calendar@group.calendar.google.com');
  });
});
