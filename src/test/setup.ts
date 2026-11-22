// Loaded before every test file (bunfig.toml). Provides the env that config/env.ts requires.
process.env.NODE_ENV = "test";
process.env.JWT_SECRET = "test-secret-test-secret-test-secret-1234";
process.env.JWT_ISSUER = "cdac-auth";
process.env.JWT_AUDIENCE = "cdac-api";
process.env.JOBS_ENABLED = "false";
process.env.RESEND_API_KEY = "re_test_dummy_key"; // deliver() tests stub fetch; nothing leaves the machine
