import { loadDotEnv, testDatabaseUrl } from "./load-env";

loadDotEnv();
process.env.DATABASE_URL = testDatabaseUrl();
// Tests never talk to real platforms or payment providers.
process.env.YOUTUBE_ADAPTER = "mock";
process.env.INSTAGRAM_ADAPTER = "mock";
process.env.PAYMENTS_PROVIDER = "mock";
process.env.EMAIL_PROVIDER = "console";
process.env.ENCRYPTION_KEY ??= "ZGV2LW9ubHkta2V5LWRvLW5vdC11c2UtaW4tcHJvZCE=";
