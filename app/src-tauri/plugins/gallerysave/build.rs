const COMMANDS: &[&str] = &["save_png", "share_png", "pick_folder", "list_folder", "pick_document", "stat_document", "read_document", "html_folder", "grant_html_folder", "read_asset"];

fn main() {
    tauri_plugin::Builder::new(COMMANDS)
        .android_path("android")
        .build();
}
