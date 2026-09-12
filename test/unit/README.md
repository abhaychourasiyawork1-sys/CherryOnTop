# Unit tests

Unit tests are deterministic and run with `npm run test:unit` on every push.
They may use local SQLite files and temporary directories, but never Docker,
Kind, PM2, network access, credentials, or a paid runtime.

Place pure module and boundary tests beside their source files, or use this
directory for cross-module unit tests.
