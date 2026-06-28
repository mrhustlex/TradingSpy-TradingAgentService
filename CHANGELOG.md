# Changelog

Notable changes to TradingSpy are documented here. The project follows [Semantic Versioning](https://semver.org/) once a version is tagged.

## Unreleased

### Added

- Docker and local-development setup paths with health checks and troubleshooting.
- GitHub Actions CI, Dependabot configuration, security policy, contribution guide, support guide, and code of conduct.
- Locked Python dependencies for reproducible Python 3.11 installations.

### Changed

- Adopted the MIT License.
- Limited the default dependency set and environment configuration to supported LLM providers.
- Made Docker builds deterministic with `npm ci` and pinned build tooling.
- Removed the globally conflicting SearXNG container name.

### Security

- Documented that generated strategy Python is unsandboxed and must be treated as untrusted code.
- Kept Docker services bound to localhost by default.
