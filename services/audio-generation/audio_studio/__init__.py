"""Local audio job service for Documentary Studio.

The public API only enqueues work. Generation, upload, and GitHub result
writes happen in separate processes so a client never holds an HTTP
connection open for the duration of a render.
"""

__version__ = "1.0.0"
