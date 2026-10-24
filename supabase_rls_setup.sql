-- ==============================================================================
-- SCRIPT DE SEGURANÇA E ROW LEVEL SECURITY (RLS) - PLANILHA GULOSA
-- ==============================================================================
-- Execute este script no SQL Editor do painel do seu Supabase:
-- https://supabase.com/dashboard/project/lakilyuxnvxexkmophkl/sql/new
--
-- O QUE ESTE SCRIPT FAZ:
-- 1. Garante que a tabela 'app_state' tenha as colunas e tipos corretos.
-- 2. Habilita o ROW LEVEL SECURITY (RLS) obrigatório.
-- 3. Bloqueia 100% de acesso anônimo/não autenticado (usuários deslogados não leem nem gravam nada).
-- 4. Cria políticas estritas onde CADA USUÁRIO autenticado só pode consultar,
--    inserir, atualizar ou apagar seus próprios dados (auth.uid() = user_id).
-- 5. Ativa o Realtime de forma segura para sincronização entre dispositivos.
-- ==============================================================================

-- 1. Cria ou ajusta a tabela app_state
CREATE TABLE IF NOT EXISTS public.app_state (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    tracker_data JSONB NOT NULL DEFAULT '{"days":[],"dailyNotes":[],"goal":{"amount":0,"startDate":""}}'::jsonb,
    global_balance NUMERIC NOT NULL DEFAULT 0,
    balance_history JSONB NOT NULL DEFAULT '[]'::jsonb,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc'::text, now())
);

-- Garante constraint UNIQUE em user_id (para suportar UPSERT com onConflict: 'user_id')
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'app_state_user_id_key'
    ) THEN
        ALTER TABLE public.app_state ADD CONSTRAINT app_state_user_id_key UNIQUE (user_id);
    END IF;
END $$;

-- Índice para consultas ultrarrápidas por usuário
CREATE INDEX IF NOT EXISTS idx_app_state_user_id ON public.app_state (user_id);

-- 2. Habilita o ROW LEVEL SECURITY (RLS)
ALTER TABLE public.app_state ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.app_state FORCE ROW LEVEL SECURITY;

-- 3. Remove quaisquer políticas antigas ou permissivas
DROP POLICY IF EXISTS "Users can only select own app_state" ON public.app_state;
DROP POLICY IF EXISTS "Users can only insert own app_state" ON public.app_state;
DROP POLICY IF EXISTS "Users can only update own app_state" ON public.app_state;
DROP POLICY IF EXISTS "Users can only delete own app_state" ON public.app_state;
DROP POLICY IF EXISTS "Enable read access for all users" ON public.app_state;
DROP POLICY IF EXISTS "Enable insert for all users" ON public.app_state;
DROP POLICY IF EXISTS "Enable update for all users" ON public.app_state;
DROP POLICY IF EXISTS "Enable delete for all users" ON public.app_state;
DROP POLICY IF EXISTS "Public access" ON public.app_state;
DROP POLICY IF EXISTS "Allow all" ON public.app_state;

-- 4. Políticas Estritas de Segurança (Somente o dono do registro pode acessar)

-- SELECT: O usuário só pode visualizar o seu próprio estado
CREATE POLICY "Users can only select own app_state"
ON public.app_state
FOR SELECT
TO authenticated
USING (auth.uid() = user_id);

-- INSERT: O usuário só pode inserir se o user_id for igual ao seu ID autenticado
CREATE POLICY "Users can only insert own app_state"
ON public.app_state
FOR INSERT
TO authenticated
WITH CHECK (auth.uid() = user_id);

-- UPDATE: O usuário só pode atualizar o seu próprio estado
CREATE POLICY "Users can only update own app_state"
ON public.app_state
FOR UPDATE
TO authenticated
USING (auth.uid() = user_id)
WITH CHECK (auth.uid() = user_id);

-- DELETE: O usuário só pode excluir o seu próprio estado
CREATE POLICY "Users can only delete own app_state"
ON public.app_state
FOR DELETE
TO authenticated
USING (auth.uid() = user_id);

-- 5. Revoga permissões de leitura/escrita do papel anônimo (público não-logado)
REVOKE ALL ON public.app_state FROM anon;

-- Concede apenas para usuários autenticados
GRANT SELECT, INSERT, UPDATE, DELETE ON public.app_state TO authenticated;

-- 6. Configuração de Realtime Seguro
ALTER TABLE public.app_state REPLICA IDENTITY FULL;

-- Adiciona à publicação do Realtime caso ainda não esteja incluída
DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime'
    ) THEN
        IF NOT EXISTS (
            SELECT 1 FROM pg_publication_tables 
            WHERE pubname = 'supabase_realtime' 
              AND schemaname = 'public' 
              AND tablename = 'app_state'
        ) THEN
            ALTER PUBLICATION supabase_realtime ADD TABLE public.app_state;
        END IF;
    END IF;
END $$;

-- Mensagem de confirmação
COMMENT ON TABLE public.app_state IS 'Tabela protegida com Row Level Security (RLS) - Planilha Gulosa';
