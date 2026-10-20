-- The database stops app_worker's queries itself. pg's client-side timeout
-- only stops the Worker waiting: the statement keeps running, so a write that
-- timed out for the client could still commit after the client was told 503.
-- A server-side statement_timeout cancels it instead (SQLSTATE 57014, answered
-- as 503 db.unavailable). 3 s keeps every query inside the Worker's 8 s
-- Postgres deadline. Set on the role, so it applies through Hyperdrive, which
-- does not pass startup options. A transaction left open is closed after 10 s.
alter role app_worker set statement_timeout = '3s';
alter role app_worker set idle_in_transaction_session_timeout = '10s';
