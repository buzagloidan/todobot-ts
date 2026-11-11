# Security

Please do not put credentials, personal data, or exploitable vulnerability details in public issues.

Use GitHub's **Security → Report a vulnerability** when private reporting is enabled. If it is unavailable, ask the maintainer for a private reporting channel without including the vulnerability details. Maintainers should enable private vulnerability reporting before publication. No response-time or supported-version commitment is currently offered.

Use your own dedicated provider accounts/resources. Never reuse the public test encryption key. Back up the deployment encryption key privately and do not replace it without migrating encrypted data. Keep webhook signing secrets and full notification API URLs out of logs and screenshots.

The test suite mocks external providers. Passing tests and a clean secret scanner do not prove that a deployment or its Git history contains no sensitive information. See docs/OPEN_SOURCE_RELEASE.md for the publication and shutdown checklist.
