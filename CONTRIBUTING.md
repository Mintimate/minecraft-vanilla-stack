# Contributing

Use the [CNB primary repository](https://cnb.cool/Mintimate/tool-forge/minecraft-vanilla-stack) for issues and pull requests. [GitHub](https://github.com/Mintimate/minecraft-vanilla-stack) is an optional code mirror.

1. Edit `packs/<id>.yaml` with fixed HTTPS file URLs, SHA-512 hashes, filenames and sides. List all required mods explicitly; `requires` records dependencies by mod ID.
2. Run `python3 tools/build.py validate` and build the affected pack. Check actual game startup, multiplayer, voice or backup behavior when those features change.
3. Describe the change and validation in a focused pull request. Preserve original author attribution and redistribution terms.

New packs are copied YAML files with their own IDs. Shared default configuration lives in `templates/`; building keeps only configuration for selected mods. Generated `pack.lock.json` is runtime metadata, not a source file to maintain.

Do not commit compiled mods, worlds, player data, account files, `.env`, RCON passwords or deployment credentials. Game builds use Python; the optional Makers `web/` module uses its own Node build and tests.

See [the YAML guide](docs/configuration.md) and [release documentation](docs/releases.md).
