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

  let googleOAuthClient: OAuth2Client | null = null;
  const credentialsPath = path.join(process.cwd(), 'credentials.json');
  const tokenPath = path.join(process.cwd(), 'token.json');

  if (fs.existsSync(credentialsPath) && fs.existsSync(tokenPath)) {
    try {
      const credentials = JSON.parse(fs.readFileSync(credentialsPath, 'utf-8'));
      const keys = credentials.installed || credentials.web;
      
      googleOAuthClient = new OAuth2Client(
        keys.client_id,
        keys.client_secret,
        'http://127.0.0.1:3000'
      );
      
      const tokenData = JSON.parse(fs.readFileSync(tokenPath, 'utf-8'));
      googleOAuthClient.setCredentials(tokenData);
    } catch (err) {
      console.warn('Failed to initialize Google OAuth Client', err);
    }
  }

  const googleCalendarId = optionalEnv('GOOGLE_CALENDAR_ID') || 'primary';

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
