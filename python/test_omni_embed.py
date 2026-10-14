"""Test Omni-Embed-Nemotron model loading and memory usage."""

import torch
import gc

def get_gpu_memory():
    """Get current GPU memory usage in GB."""
    if torch.cuda.is_available():
        return torch.cuda.memory_allocated() / 1024**3
    return 0

def main():
    print(f"CUDA available: {torch.cuda.is_available()}")
    if torch.cuda.is_available():
        print(f"GPU: {torch.cuda.get_device_name(0)}")
        print(f"Total VRAM: {torch.cuda.get_device_properties(0).total_memory / 1024**3:.1f} GB")

    print(f"\nInitial GPU memory: {get_gpu_memory():.2f} GB")

    print("\nLoading model...")
    from transformers import AutoModel, AutoProcessor

    model_name = "nvidia/omni-embed-nemotron-3b"

    # Try loading with float16 to save memory
    model = AutoModel.from_pretrained(
        model_name,
        torch_dtype=torch.float16,
        trust_remote_code=True,
        low_cpu_mem_usage=True,
    )

    print(f"After model load (CPU): {get_gpu_memory():.2f} GB")

    # Move to GPU
    model = model.to("cuda:0")
    model.eval()

    print(f"After model to GPU: {get_gpu_memory():.2f} GB")

    # Load processor
    processor = AutoProcessor.from_pretrained(model_name, trust_remote_code=True)

    print(f"After processor load: {get_gpu_memory():.2f} GB")

    print("\n[OK] Model loaded successfully!")
    print(f"Final GPU memory: {get_gpu_memory():.2f} GB")

    # Cleanup
    del model
    del processor
    gc.collect()
    torch.cuda.empty_cache()

if __name__ == "__main__":
    main()
