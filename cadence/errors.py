class CadenceError(Exception):
    status = 400


class Invalid(CadenceError):
    status = 422


class NotFound(CadenceError):
    status = 404


class Conflict(CadenceError):
    status = 409


class Forbidden(CadenceError):
    """The kind does not allow this operation."""

    status = 400
