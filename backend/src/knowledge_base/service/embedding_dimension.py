"""Local metadata for knowledge-base vector schemas."""

from __future__ import annotations

import os

from shared.errors.api import KbApiError

DEFAULT_VECTOR_DIMENSION = 1024


def configured_embedding_model() -> str:
    return (os.getenv('EMBEDDING_MODEL_NAME') or os.getenv('EMBEDDING_MODEL') or '').strip()


def resolve_embedding_dimension(model_name: str | None, default: int | None = None) -> int:
    """Return the configured schema dimension without contacting a model endpoint."""
    raw = default if default is not None else os.getenv('EMBEDDING_DIMENSION')
    try:
        dimension = int(raw)
    except (TypeError, ValueError):
        return DEFAULT_VECTOR_DIMENSION
    return dimension if dimension > 0 else DEFAULT_VECTOR_DIMENSION


def ensure_known_embedding_model(
        model_name: str | None, *, error_key: str = 'kbase.embedding.model.invalid') -> None:
    """Validate an explicit name when the deployment configures a model."""
    configured = configured_embedding_model()
    if configured and isinstance(model_name, str) and model_name.strip():
        if model_name.strip() != configured:
            raise KbApiError(error_key, model_name.strip(), code='0004')
