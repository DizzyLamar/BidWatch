create unique index if not exists app_records_users_email_unique
  on public.app_records (lower(record ->> 'email'))
  where table_name = 'users'
    and coalesce(record ->> 'email', '') <> '';
