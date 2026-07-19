import Foundation
import Vision
import AppKit

// Check arguments
guard CommandLine.arguments.count > 1 else {
    print("Error: Missing image path argument")
    exit(1)
}

let imagePath = CommandLine.arguments[1]
let fileURL = URL(fileURLWithPath: imagePath)

// Load image via NSImage
guard let nsImage = NSImage(contentsOf: fileURL) else {
    print("Error: Could not load image at \(imagePath)")
    exit(1)
}

// Convert to CGImage
guard let cgImage = nsImage.cgImage(forProposedRect: nil, context: nil, hints: nil) else {
    print("Error: Could not convert NSImage to CGImage")
    exit(1)
}

// Perform text recognition request
let request = VNRecognizeTextRequest { request, error in
    if let error = error {
        print("Error: Text recognition failed: \(error.localizedDescription)")
        return
    }
    
    guard let observations = request.results as? [VNRecognizedTextObservation] else {
        return
    }
    
    for observation in observations {
        if let candidate = observation.topCandidates(1).first {
            print(candidate.string)
        }
    }
}

// Use accurate mode for best OCR results
request.recognitionLevel = .accurate

let handler = VNImageRequestHandler(cgImage: cgImage, options: [:])
do {
    try handler.perform([request])
} catch {
    print("Error: Vision handler execution failed: \(error.localizedDescription)")
    exit(1)
}
