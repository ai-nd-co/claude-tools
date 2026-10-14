"""Test Omni-Embed with Telegram-like content (text + image + audio)."""

import torch
import torch.nn.functional as F
import os

def get_gpu_memory():
    if torch.cuda.is_available():
        return torch.cuda.memory_allocated() / 1024**3
    return 0

def get_embedding(model, processor, message_content):
    """Extract embedding from model for given content."""
    from qwen_omni_utils import process_mm_info

    message = {"role": "user", "content": message_content}
    text_input = processor.apply_chat_template([message], add_generation_prompt=False, tokenize=False)
    audio, images, videos = process_mm_info([message], use_audio_in_video=False)

    batch_dict = processor(
        text=text_input,
        images=images,
        videos=videos,
        audio=audio,
        return_tensors="pt",
        text_kwargs={"truncation": True, "padding": True, "max_length": 8192},
    )
    batch_dict = {k: v.to(model.device) for k, v in batch_dict.items()}

    with torch.no_grad():
        outputs = model(**batch_dict, output_hidden_states=True)
        last_hidden_states = outputs.hidden_states[-1]

        # Average pooling
        attention_mask = batch_dict["attention_mask"]
        last_hidden_states_masked = last_hidden_states.masked_fill(~attention_mask[..., None].bool(), 0.0)
        embedding = last_hidden_states_masked.sum(dim=1) / attention_mask.sum(dim=1)[..., None]

        # Normalize
        embedding = F.normalize(embedding, dim=-1)

    return embedding

def main():
    print(f"GPU: {torch.cuda.get_device_name(0)}")
    print(f"Initial VRAM: {get_gpu_memory():.2f} GB")

    from transformers import AutoModel, AutoProcessor

    model_name = "nvidia/omni-embed-nemotron-3b"

    # Load model
    print("\nLoading model...")
    model = AutoModel.from_pretrained(
        model_name,
        torch_dtype=torch.float16,
        trust_remote_code=True,
        low_cpu_mem_usage=True,
    )
    model = model.to("cuda:0")
    model.eval()
    print(f"Model loaded: {get_gpu_memory():.2f} GB")

    processor = AutoProcessor.from_pretrained(model_name, trust_remote_code=True)

    # Test 1: Text only
    print("\n--- Test 1: Text only ---")
    text_emb = get_embedding(model, processor, [
        {"type": "text", "text": "passage: Driver reported engine making strange noise during morning inspection"}
    ])
    print(f"Text embedding shape: {text_emb.shape}")
    print(f"VRAM: {get_gpu_memory():.2f} GB")

    # Test 2: Text + Image
    test_image = "C:/projects/workspace/repos/vision-time-tracker/scripts/debug_crop_sample.jpg"
    if os.path.exists(test_image):
        print("\n--- Test 2: Text + Image ---")
        img_emb = get_embedding(model, processor, [
            {"type": "text", "text": "passage: Driver inspection photo"},
            {"type": "image", "image": test_image}
        ])
        print(f"Text+Image embedding shape: {img_emb.shape}")
        print(f"VRAM: {get_gpu_memory():.2f} GB")

        # Similarity
        sim = F.cosine_similarity(text_emb, img_emb)
        print(f"Similarity text vs text+image: {sim.item():.4f}")

    # Test 3: Semantic search simulation
    print("\n--- Test 3: Semantic Search ---")

    messages = [
        "passage: Engine making grinding noise, needs inspection",
        "passage: DOT audit scheduled for next week",
        "passage: Truck engine problem reported by driver",
        "passage: Weather forecast shows rain tomorrow",
    ]

    embeddings = []
    for msg in messages:
        emb = get_embedding(model, processor, [{"type": "text", "text": msg}])
        embeddings.append(emb)

    # Query
    query = "query: engine noise problem"
    query_emb = get_embedding(model, processor, [{"type": "text", "text": query}])

    print(f"\nQuery: '{query}'")
    print("Results (sorted by similarity):")

    results = []
    for msg, emb in zip(messages, embeddings):
        sim = F.cosine_similarity(query_emb, emb).item()
        results.append((sim, msg))

    results.sort(reverse=True)
    for sim, msg in results:
        print(f"  {sim:.4f} - {msg}")

    print(f"\nFinal VRAM: {get_gpu_memory():.2f} GB")
    print("\n[OK] All tests passed!")

if __name__ == "__main__":
    main()
