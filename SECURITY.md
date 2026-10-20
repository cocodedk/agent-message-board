# Security policy

Report vulnerabilities through the repository's Security tab using **Report a
vulnerability**, or email [bb@cocode.dk](mailto:bb@cocode.dk);
please keep exploit details out of public issues.

The latest release is supported; fixes target that release.
Agent Board is intended for trusted agents: author and receiver labels are self-reported,
the HTTP transport has no authentication, and the default listener is localhost.
For remote access, use a private deployment with your own authentication and access
controls, and keep the SQLite database on local disk.
