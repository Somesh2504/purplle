import gdown
import os
import sys

# The Google Drive Folder ID extracted from your link
FOLDER_ID = '1mtS_OvKzUtoh_NpS5Bbo157dh0P7wqBj'

# We map this to the exact path where tracker.py expects the videos
OUTPUT_DIR = '/app/data/videos'

def main():
    print(f"[*] Starting download from Google Drive Folder: {FOLDER_ID}")
    
    # Ensure the directory exists
    os.makedirs(OUTPUT_DIR, exist_ok=True)
    
    try:
        # gdown will fetch all files in the folder
        gdown.download_folder(id=FOLDER_ID, output=OUTPUT_DIR, quiet=False, use_cookies=False)
        print("[*] Download complete. Video files successfully provisioned!")
    except Exception as e:
        print(f"[!] Error downloading from Google Drive: {e}")
        print("[!] Make sure the folder sharing settings are set to 'Anyone with the link can view'.")
        sys.exit(1)

if __name__ == "__main__":
    # If running locally outside of docker, path might be different, 
    # but inside Render/Docker it will be /app/data/videos
    if not os.path.exists('/app'):
        OUTPUT_DIR = '../data/videos'
        os.makedirs(OUTPUT_DIR, exist_ok=True)
        
    main()
