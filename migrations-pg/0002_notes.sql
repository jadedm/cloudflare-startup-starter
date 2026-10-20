create table "note" ("id" text not null primary key, "userId" text not null references "user" ("id") on delete cascade, "body" text not null, "createdAt" timestamptz not null);

create index "note_userId_idx" on "note" ("userId");
