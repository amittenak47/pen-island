const COMMANDS: &[&str] = &["save_png", "share_png", "pick_folder", "list_folder", "pick_document", "stat_document", "read_document"];

fn main() {
    tauri_plugin::Builder::new(COMMANDS)
        .android_path("android")
        .build();
}
