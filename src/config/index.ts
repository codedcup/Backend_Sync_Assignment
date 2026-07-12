import dotenv from 'dotenv';
import * as fs from 'fs';
import * as path from 'path';
import { OAuth2Client } from 'google-auth-library';

dotenv.config();

interface AppConfig {
  port: number;
  nodeEnv: string;
  databaseUrl: string;
  hubspotAccessToken: string | null;
  googleOAuthClient: OAuth2Client | null;
  googleCalendarId: string;
  squareAccessToken: string | null;
  squareLocationId: string | null;
  squareEnvironment: string | null;
}

function requireEnv(key: string): string {
  const value = process.env[key];
  if (!value) {
    throw new Error(`Missing required environment variable: ${key}`);
  }
  return value;
}

function optionalEnv(key: string): string | null {
  return process.env[key] || null;
}

function loadConfig(): AppConfig {
  const port = parseInt(process.env.PORT || '3000', 10);
  if (isNaN(port) || port <= 0 || port > 65535) {
    throw new Error(`Invalid PORT value: ${process.env.PORT}`);
  }

  const nodeEnv = process.env.NODE_ENV || 'development';
  const databaseUrl = requireEnv('DATABASE_URL');

  // HubSpot: optional — sync will fail gracefully if not configured
  const hubspotAccessToken = optionalEnv('HUBSPOT_ACCESS_TOKEN');

  const googleClientId = optionalEnv('GOOGLE_CLIENT_ID');
  const googleClientSecret = optionalEnv('GOOGLE_CLIENT_SECRET');
  const googleRefreshToken = optionalEnv('GOOGLE_REFRESH_TOKEN');
  const configuredGoogleCalendarId = optionalEnv('GOOGLE_CALENDAR_ID');

  const googleAuthVars = [googleClientId, googleClientSecret, googleRefreshToken, configuredGoogleCalendarId];
  const providedCount = googleAuthVars.filter(v => v !== null).length;

  if (providedCount > 0 && providedCount < 4) {
    throw new Error('Google Calendar configuration is incomplete. You must provide all four variables (GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REFRESH_TOKEN, GOOGLE_CALENDAR_ID) or none at all.');
  }

  let googleOAuthClient: OAuth2Client | null = null;
  let googleCalendarId = 'primary';

  if (providedCount === 4) {
    googleOAuthClient = new OAuth2Client(googleClientId!, googleClientSecret!, 'http://127.0.0.1:3000');
    googleOAuthClient.setCredentials({ refresh_token: googleRefreshToken! });
    googleCalendarId = configuredGoogleCalendarId!;
  }

  return {
    port,
    nodeEnv,
    databaseUrl,
    hubspotAccessToken,
    googleOAuthClient,
    googleCalendarId,
    squareAccessToken: optionalEnv('SQUARE_ACCESS_TOKEN'),
    squareLocationId: optionalEnv('SQUARE_LOCATION_ID'),
    squareEnvironment: optionalEnv('SQUARE_ENVIRONMENT'),
  };
}

export const config = loadConfig();
