use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use std::sync::{Arc, Mutex};
use std::time::Duration;

fn main() {
    let host = cpal::default_host();

    println!("Available hosts: {:?}", cpal::available_hosts());
    println!("Default host: {:?}", host.id());

    // List all input devices
    println!("\nAvailable input devices:");
    if let Ok(devices) = host.input_devices() {
        for (i, device) in devices.enumerate() {
            let name = device.name().unwrap_or_default();
            let is_default = host
                .default_input_device()
                .map(|d| d.name().ok() == Some(name.clone()))
                .unwrap_or(false);
            println!(
                "  [{}] {} {}",
                i,
                name,
                if is_default { "(default)" } else { "" }
            );
        }
    }

    match host.default_input_device() {
        Some(device) => {
            println!("\nUsing device: {:?}", device.name());

            match device.default_input_config() {
                Ok(config) => {
                    println!("Sample rate: {}", config.sample_rate().0);
                    println!("Channels: {}", config.channels());
                    println!("Sample format: {:?}", config.sample_format());

                    let buffer = Arc::new(Mutex::new(Vec::<f32>::new()));
                    let buffer_clone = buffer.clone();
                    let channels = config.channels() as usize;

                    let stream_config: cpal::StreamConfig = config.clone().into();

                    println!("\nBuilding input stream...");
                    let stream = match device.build_input_stream(
                        &stream_config,
                        move |data: &[f32], _: &cpal::InputCallbackInfo| {
                            let mono: Vec<f32> = data
                                .chunks(channels)
                                .map(|chunk| chunk.iter().sum::<f32>() / channels as f32)
                                .collect();
                            if let Ok(mut buf) = buffer_clone.lock() {
                                buf.extend_from_slice(&mono);
                            }
                        },
                        |err| eprintln!("Stream error: {}", err),
                        None,
                    ) {
                        Ok(s) => s,
                        Err(e) => {
                            eprintln!("Failed to build stream: {}", e);
                            return;
                        }
                    };

                    println!("Starting stream...");
                    if let Err(e) = stream.play() {
                        eprintln!("Failed to play stream: {}", e);
                        return;
                    }

                    println!("Recording for 3 seconds... (speak into microphone)");

                    for i in 1..=6 {
                        std::thread::sleep(Duration::from_millis(500));
                        let samples = buffer.lock().unwrap();
                        let count = samples.len();
                        let rms = if !samples.is_empty() {
                            (samples.iter().map(|s| s * s).sum::<f32>() / count as f32).sqrt()
                        } else {
                            0.0
                        };
                        println!(
                            "  [{:.1}s] {} samples, RMS: {:.4}",
                            i as f32 * 0.5,
                            count,
                            rms
                        );
                    }

                    let samples = buffer.lock().unwrap();
                    println!("\n=== Final Results ===");
                    println!("Total samples: {}", samples.len());

                    if !samples.is_empty() {
                        let rms: f32 = (samples.iter().map(|s| s * s).sum::<f32>()
                            / samples.len() as f32)
                            .sqrt();
                        let max = samples.iter().map(|s| s.abs()).fold(0.0f32, f32::max);
                        let min = samples.iter().map(|s| s.abs()).fold(f32::MAX, f32::min);
                        println!("RMS level: {:.6}", rms);
                        println!("Max amplitude: {:.6}", max);
                        println!("First 10 samples: {:?}", &samples[..10.min(samples.len())]);
                    } else {
                        println!("ERROR: No samples captured!");
                    }
                }
                Err(e) => println!("Failed to get config: {}", e),
            }
        }
        None => println!("ERROR: No default input device found!"),
    }
}
