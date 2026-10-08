-- 0002_core_tables
-- Minimum tables to prove tenant + student isolation (Slice 1). Owner: app_migrator.
-- Spike simplification (documented in docs/architecture/v3/13): guardian contact fields live inline in
-- student_guardians; Slice 4 splits out `guardians` per 02 §4.4.

CREATE TABLE app.organizations (
  id          app.uuid_v7 PRIMARY KEY,
  name        text        NOT NULL CHECK (char_length(name) BETWEEN 1 AND 255),
  slug        text        NOT NULL CHECK (slug ~ '^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$'),
  status      text        NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'SUSPENDED', 'ARCHIVED')),
  version     integer     NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT organizations_slug_uq UNIQUE (slug)
);

CREATE TABLE app.users (
  id               app.uuid_v7 PRIMARY KEY,
  organization_id  app.uuid_v7 NOT NULL REFERENCES app.organizations (id) ON DELETE RESTRICT,
  email            text        NOT NULL CHECK (email = lower(email) AND char_length(email) BETWEEN 3 AND 320),
  display_name     text        NOT NULL CHECK (char_length(display_name) BETWEEN 1 AND 200),
  status           text        NOT NULL DEFAULT 'INVITED'
                   CHECK (status IN ('INVITED', 'ACTIVE', 'SUSPENDED', 'DEACTIVATED')),
  version          integer     NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT users_org_email_uq UNIQUE (organization_id, email),
  -- target of composite foreign keys: makes cross-tenant references impossible by construction
  CONSTRAINT users_org_id_uq    UNIQUE (organization_id, id)
);

CREATE TABLE app.students (
  id                app.uuid_v7 PRIMARY KEY,                  -- permanent internal student identity
  organization_id   app.uuid_v7 NOT NULL,
  user_id           app.uuid_v7 NOT NULL,                     -- identity mapping: login account -> student
  admission_number  text        NOT NULL CHECK (char_length(admission_number) BETWEEN 1 AND 50),
  status            text        NOT NULL DEFAULT 'ADMITTED'
                    CHECK (status IN ('ADMITTED', 'ACTIVE', 'ON_LEAVE', 'SUSPENDED', 'DISCONTINUED', 'GRADUATED', 'TRANSFERRED_OUT')),
  version           integer     NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT students_org_fk        FOREIGN KEY (organization_id) REFERENCES app.organizations (id) ON DELETE RESTRICT,
  CONSTRAINT students_user_fk       FOREIGN KEY (organization_id, user_id) REFERENCES app.users (organization_id, id) ON DELETE RESTRICT,
  CONSTRAINT students_org_adm_uq    UNIQUE (organization_id, admission_number),
  CONSTRAINT students_org_user_uq   UNIQUE (organization_id, user_id),
  CONSTRAINT students_org_id_uq     UNIQUE (organization_id, id)
);

CREATE TABLE app.student_guardians (
  id               app.uuid_v7 PRIMARY KEY,
  organization_id  app.uuid_v7 NOT NULL,
  student_id       app.uuid_v7 NOT NULL,                      -- ownership: whose protected data this is
  full_name        text        NOT NULL CHECK (char_length(full_name) BETWEEN 1 AND 200),
  phone            text        NOT NULL CHECK (char_length(phone) BETWEEN 5 AND 30),
  email            text        CHECK (email IS NULL OR (email = lower(email) AND char_length(email) <= 320)),
  relation         text        NOT NULL CHECK (char_length(relation) BETWEEN 1 AND 50),
  is_primary       boolean     NOT NULL DEFAULT false,
  version          integer     NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT student_guardians_org_fk     FOREIGN KEY (organization_id) REFERENCES app.organizations (id) ON DELETE RESTRICT,
  CONSTRAINT student_guardians_student_fk FOREIGN KEY (organization_id, student_id) REFERENCES app.students (organization_id, id) ON DELETE RESTRICT
);
CREATE INDEX student_guardians_org_student_ix ON app.student_guardians (organization_id, student_id);
CREATE UNIQUE INDEX student_guardians_one_primary_uq ON app.student_guardians (student_id) WHERE is_primary;

-- Row maintenance
CREATE TRIGGER organizations_touch BEFORE UPDATE ON app.organizations FOR EACH ROW EXECUTE FUNCTION app.touch_row();
CREATE TRIGGER users_touch         BEFORE UPDATE ON app.users          FOR EACH ROW EXECUTE FUNCTION app.touch_row();
CREATE TRIGGER students_touch      BEFORE UPDATE ON app.students       FOR EACH ROW EXECUTE FUNCTION app.touch_row();
CREATE TRIGGER student_guardians_touch BEFORE UPDATE ON app.student_guardians FOR EACH ROW EXECUTE FUNCTION app.touch_row();

CREATE TRIGGER organizations_immutable BEFORE UPDATE ON app.organizations FOR EACH ROW EXECUTE FUNCTION app.enforce_immutable_keys();
CREATE TRIGGER users_immutable         BEFORE UPDATE ON app.users          FOR EACH ROW EXECUTE FUNCTION app.enforce_immutable_keys();
CREATE TRIGGER students_immutable      BEFORE UPDATE ON app.students       FOR EACH ROW EXECUTE FUNCTION app.enforce_immutable_keys();
CREATE TRIGGER student_guardians_immutable BEFORE UPDATE ON app.student_guardians FOR EACH ROW EXECUTE FUNCTION app.enforce_immutable_keys();
