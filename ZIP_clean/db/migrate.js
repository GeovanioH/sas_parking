/**
 * db/migrate.js — SAS Parking v2.0
 * Crée et met à jour les tables PostgreSQL au démarrage.
 */
const pool = require('./pool');

const SQL = `
-- =============================================
-- TYPES ENUM
-- =============================================
DO $$ BEGIN CREATE TYPE mode_tarifaire_enum  AS ENUM ('heure','garde');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN CREATE TYPE mode_paiement_enum   AS ENUM ('mobile_money','especes');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN CREATE TYPE statut_session_enum  AS ENUM ('en_cours','cloture','annule');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN CREATE TYPE statut_paiement_enum AS ENUM ('en_attente','confirme','echoue','rembourse');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN CREATE TYPE notif_type_enum      AS ENUM ('sms','email');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN CREATE TYPE notif_statut_enum    AS ENUM ('envoye','echoue','en_attente');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- =============================================
-- TABLE : SITES  (= table admin)
-- Un site = un parking = un compte administrateur
-- =============================================
CREATE TABLE IF NOT EXISTS sites (
  id              SERIAL PRIMARY KEY,
  nom_parking     VARCHAR(100)  NOT NULL,
  ville           VARCHAR(100)  NOT NULL,
  nom             VARCHAR(100)  NOT NULL,
  prenom          VARCHAR(100)  NOT NULL,
  telephone       VARCHAR(20)   NOT NULL UNIQUE,
  mot_de_passe    VARCHAR(255)  NOT NULL,
  capacite        INTEGER       DEFAULT 50,
  photo_admin     TEXT          NULL,
  photo_site      TEXT          NULL,
  adresse         VARCHAR(255)  NULL,
  description     TEXT          NULL,
  created_at      TIMESTAMPTZ   DEFAULT NOW(),
  updated_at      TIMESTAMPTZ   DEFAULT NOW()
);

-- =============================================
-- TABLE : AGENTS
-- =============================================
CREATE TABLE IF NOT EXISTS agents (
  id           SERIAL PRIMARY KEY,
  site_id      INTEGER      NOT NULL REFERENCES sites(id) ON DELETE RESTRICT,
  nom          VARCHAR(100) NOT NULL,
  prenom       VARCHAR(100) NOT NULL,
  telephone    VARCHAR(20)  NOT NULL UNIQUE,
  mot_de_passe VARCHAR(255) NOT NULL,
  photo_agent  TEXT         NULL,
  actif        BOOLEAN      DEFAULT TRUE,
  created_at   TIMESTAMPTZ  DEFAULT NOW(),
  updated_at   TIMESTAMPTZ  DEFAULT NOW(),
  deleted_at   TIMESTAMPTZ  NULL
);

-- =============================================
-- TABLE : TARIFS
-- =============================================
CREATE TABLE IF NOT EXISTS tarifs (
  id             SERIAL PRIMARY KEY,
  site_id        INTEGER             NOT NULL REFERENCES sites(id) ON DELETE RESTRICT,
  prix_par_heure NUMERIC(10,2)       NOT NULL DEFAULT 0,
  prix_minimum   NUMERIC(10,2)       NOT NULL DEFAULT 0,
  mode_tarifaire mode_tarifaire_enum NOT NULL DEFAULT 'garde',
  prix_tarif     NUMERIC(10,2)       NOT NULL DEFAULT 0,
  heure_debut    SMALLINT            NOT NULL DEFAULT 0,
  actif          BOOLEAN             DEFAULT TRUE,
  created_at     TIMESTAMPTZ         DEFAULT NOW()
);

-- =============================================
-- TABLE : SESSIONS
-- =============================================
CREATE TABLE IF NOT EXISTS sessions (
  id               SERIAL PRIMARY KEY,
  site_id          INTEGER             NOT NULL REFERENCES sites(id)   ON DELETE RESTRICT,
  agent_id         INTEGER             NOT NULL REFERENCES agents(id)  ON DELETE RESTRICT,
  nom_client       VARCHAR(100)        NOT NULL DEFAULT '',
  prenom_client    VARCHAR(100)        NOT NULL DEFAULT '',
  telephone_client VARCHAR(20)         NOT NULL DEFAULT '',
  plaque           VARCHAR(30)         NOT NULL,
  numero_cip       VARCHAR(30)         NULL,
  code_hex         VARCHAR(20)         NOT NULL UNIQUE,
  heure_entree     TIMESTAMPTZ         DEFAULT NOW(),
  heure_sortie     TIMESTAMPTZ         NULL,
  montant          NUMERIC(10,2)       NULL,
  mode_paiement    mode_paiement_enum  NULL,
  statut           statut_session_enum DEFAULT 'en_cours',
  pdf_recu         TEXT                NULL,
  created_at       TIMESTAMPTZ         DEFAULT NOW(),
  updated_at       TIMESTAMPTZ         DEFAULT NOW(),
  deleted_at       TIMESTAMPTZ         NULL
);

-- =============================================
-- TABLE : PAIEMENTS
-- =============================================
CREATE TABLE IF NOT EXISTS paiements (
  id                SERIAL PRIMARY KEY,
  session_id        INTEGER              NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  montant           NUMERIC(10,2)        NOT NULL,
  mode              mode_paiement_enum   NOT NULL,
  statut            statut_paiement_enum DEFAULT 'en_attente',
  reference_fedapay VARCHAR(100)         UNIQUE NULL,
  paid_at           TIMESTAMPTZ          NULL,
  created_at        TIMESTAMPTZ          DEFAULT NOW(),
  updated_at        TIMESTAMPTZ          DEFAULT NOW()
);

-- =============================================
-- TABLE : NOTIFICATIONS
-- =============================================
CREATE TABLE IF NOT EXISTS notifications (
  id         SERIAL PRIMARY KEY,
  session_id INTEGER           NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  type       notif_type_enum   NOT NULL,
  message    TEXT              NULL,
  statut     notif_statut_enum NOT NULL DEFAULT 'en_attente',
  tentatives INTEGER           DEFAULT 0,
  sent_at    TIMESTAMPTZ       DEFAULT NOW()
);

-- =============================================
-- TABLE : ABONNEMENTS JOURNALIERS
-- =============================================
CREATE TABLE IF NOT EXISTS abonnements (
  id            SERIAL PRIMARY KEY,
  site_id       INTEGER       NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  montant       NUMERIC(10,2) NOT NULL,
  pourcentage   NUMERIC(5,2)  NOT NULL DEFAULT 5.00,
  statut        VARCHAR(20)   NOT NULL DEFAULT 'en_attente',
  date_echeance DATE          NOT NULL,
  paid_at       TIMESTAMPTZ   NULL,
  created_at    TIMESTAMPTZ   DEFAULT NOW()
);

-- =============================================
-- TABLE : RESET TOKENS (mot de passe oublié)
-- =============================================
CREATE TABLE IF NOT EXISTS reset_tokens (
  id         SERIAL PRIMARY KEY,
  telephone  VARCHAR(30) NOT NULL,
  token      VARCHAR(64) NOT NULL UNIQUE,
  role       VARCHAR(10) NOT NULL DEFAULT 'admin',
  used       BOOLEAN     DEFAULT FALSE,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- =============================================
-- MIGRATIONS ADDITIVES (colonnes nouvelles sur tables existantes)
-- =============================================
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='sites' AND column_name='photo_admin') THEN
    ALTER TABLE sites ADD COLUMN photo_admin TEXT NULL;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='sites' AND column_name='photo_site') THEN
    ALTER TABLE sites ADD COLUMN photo_site TEXT NULL;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='sites' AND column_name='adresse') THEN
    ALTER TABLE sites ADD COLUMN adresse VARCHAR(255) NULL;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='sites' AND column_name='description') THEN
    ALTER TABLE sites ADD COLUMN description TEXT NULL;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='agents' AND column_name='photo_agent') THEN
    ALTER TABLE agents ADD COLUMN photo_agent TEXT NULL;
  END IF;
END $$;

-- Supprimer admin_id sur agents si elle existe (résidu d'erreur passée)
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='agents' AND column_name='admin_id') THEN
    ALTER TABLE agents DROP COLUMN admin_id;
  END IF;
END $$;

-- Ajouter telephone_payout sur sites si absent
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='sites' AND column_name='telephone_payout') THEN
    ALTER TABLE sites ADD COLUMN telephone_payout VARCHAR(20) NULL;
  END IF;
END $$;

-- Table virements journaliers
CREATE TABLE IF NOT EXISTS virements (
  id                SERIAL PRIMARY KEY,
  site_id           INTEGER        NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  montant           NUMERIC(10,2)  NOT NULL,
  telephone         VARCHAR(20)    NOT NULL,
  statut            VARCHAR(20)    NOT NULL DEFAULT 'en_attente',
  reference_fedapay VARCHAR(100)   NULL,
  date_virement     DATE           NOT NULL,
  created_at        TIMESTAMPTZ    DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_virements_site ON virements(site_id);
CREATE INDEX IF NOT EXISTS idx_virements_date ON virements(date_virement);

-- [M1] Colonnes phase_actuelle et transaction_id_fedapay sur abonnements
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='abonnements' AND column_name='phase_actuelle') THEN
    ALTER TABLE abonnements ADD COLUMN phase_actuelle SMALLINT DEFAULT 1;
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='abonnements' AND column_name='transaction_id_fedapay') THEN
    ALTER TABLE abonnements ADD COLUMN transaction_id_fedapay VARCHAR(100) NULL;
  END IF;
END $$;

-- [C4] Corriger les anciens abonnements avec pourcentage = 5 → 10
UPDATE abonnements SET pourcentage = 10 WHERE pourcentage = 5 AND statut = 'en_attente';

-- =============================================
-- INDEX
-- =============================================
CREATE INDEX IF NOT EXISTS idx_agents_site        ON agents(site_id);
CREATE INDEX IF NOT EXISTS idx_sessions_site      ON sessions(site_id);
CREATE INDEX IF NOT EXISTS idx_sessions_agent     ON sessions(agent_id);
CREATE INDEX IF NOT EXISTS idx_sessions_code_hex  ON sessions(code_hex);
CREATE INDEX IF NOT EXISTS idx_sessions_plaque    ON sessions(plaque);
CREATE INDEX IF NOT EXISTS idx_sessions_statut    ON sessions(statut);
CREATE INDEX IF NOT EXISTS idx_paiements_session  ON paiements(session_id);
CREATE INDEX IF NOT EXISTS idx_paiements_statut   ON paiements(statut);
CREATE INDEX IF NOT EXISTS idx_tarifs_site        ON tarifs(site_id);
CREATE INDEX IF NOT EXISTS idx_notifs_session     ON notifications(session_id);
CREATE INDEX IF NOT EXISTS idx_abonnements_site   ON abonnements(site_id);
CREATE INDEX IF NOT EXISTS idx_reset_telephone    ON reset_tokens(telephone);

-- =============================================
-- FONCTION updated_at automatique
-- =============================================
CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER AS $$
BEGIN NEW.updated_at = NOW(); RETURN NEW; END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_sites_updated_at     ON sites;
DROP TRIGGER IF EXISTS trg_agents_updated_at    ON agents;
DROP TRIGGER IF EXISTS trg_sessions_updated_at  ON sessions;
DROP TRIGGER IF EXISTS trg_paiements_updated_at ON paiements;

CREATE TRIGGER trg_sites_updated_at
  BEFORE UPDATE ON sites FOR EACH ROW EXECUTE FUNCTION update_updated_at();
CREATE TRIGGER trg_agents_updated_at
  BEFORE UPDATE ON agents FOR EACH ROW EXECUTE FUNCTION update_updated_at();
CREATE TRIGGER trg_sessions_updated_at
  BEFORE UPDATE ON sessions FOR EACH ROW EXECUTE FUNCTION update_updated_at();
CREATE TRIGGER trg_paiements_updated_at
  BEFORE UPDATE ON paiements FOR EACH ROW EXECUTE FUNCTION update_updated_at();
`;

async function migrate() {
  try {
    await pool.query(SQL);
    console.log('[DB] Tables PostgreSQL vérifiées / créées (v2.0).');
  } catch (err) {
    console.error('[DB] Erreur migration :', err.message);
    process.exit(1);
  }
}

module.exports = migrate;