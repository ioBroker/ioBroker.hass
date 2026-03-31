# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

ioBroker.hass is an ioBroker adapter that connects Home Assistant to ioBroker via WebSocket API. It reads Home Assistant entities/services and exposes them as ioBroker objects, and forwards ioBroker state changes back as Home Assistant service calls.

## Commands

```bash
# Build TypeScript
npm run build

# Run all tests (Mocha)
npm test

# Run only package validation tests
npm run test:package

# Lint
npm run lint

# Format check
npx prettier --check .

# Translate adapter strings
npm run translate

# Release (patch/minor/major)
npm run release-patch
npm run release-minor
npm run release-major
```

## Architecture

TypeScript class-based adapter. Source in `src/`, compiled output in `build/`.

- **src/main.ts** — `HassAdapter` class extending `Adapter`. Daemon mode entry point. Handles:
  - Connecting to Home Assistant and syncing entities/services into ioBroker objects
  - `parseStates()` — maps HASS entities, attributes, and services to ioBroker channels/states
  - `onStateChange()` — converts ioBroker commands (`ack=false`) into HASS `callService()` calls, supporting both direct values (single-field services) and JSON-stringified objects (multi-field services)
  - Object/state synchronization via `syncObjects`/`syncStates`

- **src/lib/hass.ts** — `HASS` class extending `EventEmitter`. WebSocket client for Home Assistant with:
  - Auto-reconnect (3s delay)
  - Message ID tracking for request-response correlation
  - Methods: `getConfig`, `getStates`, `getServices`, `getPanels`, `callService`
  - Events: `connected`, `disconnected`, `error`, `state_changed`

The codebase uses **callback-based async** (no promises/async-await).

## Testing

Tests use Mocha with two ioBroker-specific frameworks:
- `@iobroker/legacy-testing` — spins up a js-controller instance for integration tests (`test/testAdapter.js`)
- `@iobroker/testing` — validates package.json and io-package.json structure (`test/testPackageFiles.js`)

## Configuration

Adapter config (defined in `io-package.json`): `host`, `port`, `password` (long-lived access token), `secure` (boolean for wss).

## CI

GitHub Actions runs lint on Node 22, adapter tests on Node 20/22/24 across Linux/Windows/macOS. Deploys to npm on semantic version tags via OIDC trusted publishing.
