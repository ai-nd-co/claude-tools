"""Test Omni-Embed with audio query against text passages."""

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
        audio_kwargs={"max_length": 480000},  # ~30 seconds at 16kHz
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
    audio_file = "C:/projects/workspace/data/test-audio.ogg"

    if not os.path.exists(audio_file):
        print(f"Audio file not found: {audio_file}")
        return

    print(f"GPU: {torch.cuda.get_device_name(0)}")
    print(f"Audio file: {audio_file}")

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

    # Create text passage embeddings (simulating Telegram messages database)
    print("\n--- Embedding text passages ---")
    messages = [
        "passage: Engine making grinding noise, needs inspection",
        "passage: DOT audit scheduled for next week",
        "passage: Truck engine problem reported by driver",
        "passage: Weather forecast shows rain tomorrow",
        "passage: Driver needs to check the engine noise",
        "passage: Brake pads need replacement soon",
        "passage: Fuel efficiency report looks good",
        "passage: Strange sound coming from engine compartment",
    ]

    embeddings = []
    for i, msg in enumerate(messages):
        emb = get_embedding(model, processor, [{"type": "text", "text": msg}])
        embeddings.append(emb)
        print(f"  [{i+1}/{len(messages)}] Embedded: {msg[:50]}...")

    # Now embed the AUDIO file as query
    print("\n--- Embedding audio query ---")
    print(f"Audio: {audio_file}")
    # Transcription: "um noise inside of the inside the engine we need to check this"

    audio_emb = get_embedding(model, processor, [
        {"type": "audio", "audio": audio_file}
    ])
    print(f"Audio embedding shape: {audio_emb.shape}")
    print(f"VRAM: {get_gpu_memory():.2f} GB")

    # Search: find most similar text passages to the audio
    print("\n--- Audio-to-Text Search Results ---")
    print("(Audio says: 'um noise inside of the inside the engine we need to check this')")
    print("\nMatching passages:")

    results = []
    for msg, emb in zip(messages, embeddings):
        sim = F.cosine_similarity(audio_emb, emb).item()
        results.append((sim, msg))

    results.sort(reverse=True)
    for i, (sim, msg) in enumerate(results):
        marker = " <-- TOP MATCH" if i == 0 else ""
        print(f"  {sim:.4f} - {msg}{marker}")

    # Also test text query for comparison
    print("\n--- Text Query Comparison ---")
    text_query = "query: engine noise need to check"
    text_query_emb = get_embedding(model, processor, [{"type": "text", "text": text_query}])

    print(f"Text query: '{text_query}'")

    text_results = []
    for msg, emb in zip(messages, embeddings):
        sim = F.cosine_similarity(text_query_emb, emb).item()
        text_results.append((sim, msg))

    text_results.sort(reverse=True)
    print("Top 3 matches:")
    for sim, msg in text_results[:3]:
        print(f"  {sim:.4f} - {msg}")

    # Similarity between audio query and equivalent text query
    audio_text_sim = F.cosine_similarity(audio_emb, text_query_emb).item()
    print(f"\nAudio <-> Text query similarity: {audio_text_sim:.4f}")

    print(f"\nFinal VRAM: {get_gpu_memory():.2f} GB")
    print("\n[OK] Audio search test complete!")

if __name__ == "__main__":
    main()
