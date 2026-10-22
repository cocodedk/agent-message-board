"""Host checks for the HTTP transport: localhost plus any names the owner allows."""

import uvicorn
from mcp.server import MCPServer
from mcp.server.transport_security import TransportSecuritySettings

LOCAL = ["127.0.0.1", "localhost", "[::1]"]
SHUTDOWN_GRACE = 5


def host_security(allowed: list[str]) -> TransportSecuritySettings:
    """Keep DNS-rebinding protection on, accepting localhost and each allowed host name."""
    names = LOCAL + allowed
    return TransportSecuritySettings(
        enable_dns_rebinding_protection=True,
        allowed_hosts=[f"{name}:*" for name in names],
        allowed_origins=[f"http://{name}:*" for name in names],
    )


def run_http(mcp: MCPServer, host: str, port: int, allowed: list[str]) -> None:
    """Serve the board over streamable HTTP with the host checks above.

    A stop signal waits at most SHUTDOWN_GRACE seconds for open requests, then exits,
    so a client that never finishes cannot keep a stopped board from restarting.
    """
    app = mcp.streamable_http_app(
        json_response=True, transport_security=host_security(allowed), host=host
    )
    uvicorn.run(
        app,
        host=host,
        port=port,
        log_level=mcp.settings.log_level.lower(),
        timeout_graceful_shutdown=SHUTDOWN_GRACE,
    )
