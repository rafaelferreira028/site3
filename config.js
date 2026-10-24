/**
 * Configuração de ambiente do Supabase (Frontend / GitHub Pages)
 * 
 * SEGURANÇA:
 * - A chave 'SUPABASE_ANON_KEY' ('sb_publishable_...') é uma chave PÚBLICA / PUBLISHABLE.
 * - Ela é necessária no navegador para conectar à API do Supabase e realizar login/consultas.
 * - O isolamento e a proteção total dos dados de cada usuário são garantidos pelo
 *   Row Level Security (RLS) diretamente no banco de dados Supabase (ver supabase_rls_setup.sql).
 * - NUNCA coloque a chave 'service_role' (chave mestra privada) no frontend ou no repositório.
 */
window.__CONFIG__ = {
  SUPABASE_URL: 'https://lakilyuxnvxexkmophkl.supabase.co',
  SUPABASE_ANON_KEY: 'sb_publishable_GKkPy4bq09hBeEpcsMuTfA_SX9EYOhm'
};

