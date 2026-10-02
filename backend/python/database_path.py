"""Use the same database selection as the Node backend."""
import os


def get_database_path():
    return os.environ.get('DB_PATH_OVERRIDE') or os.path.join(
        os.path.dirname(__file__), '..', 'database', 'stocks.db')
