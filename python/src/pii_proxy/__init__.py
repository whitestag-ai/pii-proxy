"""Python client for pii-proxy HTTP server."""
from pii_proxy.client import (
    PiiProxyClient,
    AnonymizeResult,
    AnonymizeBlocked,
    SafeCallResult,
    SafeCallBlocked,
    PiiProxyError,
)

__version__ = "0.1.0"
__all__ = [
    "PiiProxyClient",
    "AnonymizeResult",
    "AnonymizeBlocked",
    "SafeCallResult",
    "SafeCallBlocked",
    "PiiProxyError",
]
