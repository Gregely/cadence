"""Give existing documents their kind's default role (from the registry)."""


def upgrade(conn):
    from cadence.library import fill_role_defaults

    fill_role_defaults(conn)
