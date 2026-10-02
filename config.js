// Supabase の接続先。SETUP.md の手順で作ったプロジェクトの値を入れる。
// publishable key（anon key）は画面から使う前提の公開用の鍵。secret / service_role の鍵は絶対に入れない。
// 空のままだと、店の釣果の一覧と地図だけが動く。
window.CHOKA_CONFIG = {
  supabaseUrl: "https://qfjfeywptmklucoewhhi.supabase.co",
  supabaseAnonKey: "sb_publishable_R45Aza_ba_Aq6XvhZRj1ag_1EPsuoNi",
};
