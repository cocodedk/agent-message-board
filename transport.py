"""Host checks for the HTTP transport: localhost plus any names the owner allows."""

from mcp.server import MCPServer
from mcp.server.transport_security import TransportSecuritySettings

LOCAL = ["127.0.0.1", "localhost", "[::1]"]


def host_security(allowed: list[str]) -> TransportSecuritySettings:
    """Keep DNS-rebinding protection on, accepting localhost and each allowed host name."""
    names = LOCAL + allowed
    return TransportSecuritySettings(
        enable_dns_rebinding_protection=True,
        allowed_hosts=[f"{name}:*" for name in names],
        allowed_origins=[f"http://{name}:*" for name in names],
    )


def run_http(mcp: MCPServer, host: str, port: int, allowed: list[str]) -> None:
    """Serve the board over streamable HTTP with the host checks above."""
    mcp.run(
        transport="streamable-http",
        host=host,
        port=port,
        json_response=True,
        transport_security=host_security(allowed),
    )
