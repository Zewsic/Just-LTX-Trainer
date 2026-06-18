mod shell;
mod tmux_task;
mod ssh;
mod http;
mod transfer;
mod notify;
mod keys;
mod servers;
mod ssh_key;
mod nvidia;
mod init;
mod projects;
mod local_setup;
mod dataset_build;
mod dataset_upload;
mod caption;
mod training;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_store::Builder::default().build())
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            ssh::ssh_exec,
            ssh::pod_ssh_probe,
            http::http_request,
            transfer::transfer_run,
            notify::notify,
            keys::runpod_balance,
            keys::gemini_check,
            servers::list_pods,
            servers::pod_action,
            servers::list_gpu_types,
            servers::deploy_pod,
            ssh_key::setup_runpod_ssh_key,
            ssh_key::get_ssh_key_status,
            ssh_key::revoke_runpod_ssh_key,
            nvidia::pod_nvidia_smi,
            init::check_init_state,
            init::start_init_step,
            init::tail_init_log,
            init::reset_init_step,
            projects::list_projects,
            projects::load_project,
            projects::save_project,
            projects::create_project,
            projects::delete_project,
            local_setup::check_local_tools,
            local_setup::install_ffmpeg,
            local_setup::install_runpodctl,
            dataset_build::build_dataset,
            dataset_build::copy_file,
            dataset_build::read_text_file,
            dataset_build::write_text_file,
            dataset_upload::upload_dataset,
            caption::check_caption_state,
            caption::start_caption,
            caption::tail_caption_log,
            caption::reset_caption,
            caption::test_caption,
            caption::read_pod_clip,
            caption::fetch_pod_captions,
            caption::write_pod_captions,
            training::start_training,
            training::export_training_config,
            training::check_training_state,
            training::tail_training_log,
            training::reset_training,
            training::list_validation_steps,
            training::list_validation_files,
            training::read_validation_file,
            training::checkpoint_info,
            training::checkpoint_send_start,
            training::checkpoint_send_state,
            training::checkpoint_send_stop,
            training::runpodctl_receive_local,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
