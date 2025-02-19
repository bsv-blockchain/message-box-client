import type { JestConfigWithTsJest } from 'ts-jest'

const config: JestConfigWithTsJest = {
  preset: 'ts-jest',
  testEnvironment: 'jsdom', // The client runs in a browser
  moduleFileExtensions: ['ts', 'tsx', 'js', 'jsx', 'json', 'node'],
  transform: {
    '^.+\\.ts?$': 'ts-jest'
  },
  testMatch: ['**/test/integration/**/*.test.ts'], // Run only integration tests
  verbose: true,
  setupFilesAfterEnv: ['./jest.setup.client.ts'],
  globals: {
    'ts-jest': {
      isolatedModules: true
    }
  },
  testTimeout: 30000 // Allow longer timeouts for WebSocket tests
}

export default config
