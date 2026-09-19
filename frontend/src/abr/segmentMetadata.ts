export interface SegmentInfo {
  segment: number;
  sizeBytes: number;
  duration: number;
}

export interface QualitySegmentInfo {
  index: number;
  name: string;
  segments: SegmentInfo[];
}

export interface SegmentMetadata {
  video: string;
  qualities: QualitySegmentInfo[];
}


const METADATA_URL =
  "http://localhost:5000/api/videos/sample/segments";


let metadata: SegmentMetadata | null = null;


/*
 * Load metadata once.
 */
export async function loadSegmentMetadata(): Promise<SegmentMetadata> {

  if (metadata) {
    return metadata;
  }


  const response =
    await fetch(METADATA_URL);


  if (!response.ok) {

    throw new Error(
      `Failed to load segment metadata: ${response.status}`
    );
  }


  metadata =
    (await response.json()) as SegmentMetadata;


  return metadata;
}


/*
 * Find information for a particular
 * quality + segment.
 */
export function getSegmentInfo(
  qualityIndex: number,
  segmentNumber: number
): SegmentInfo | null {

  if (!metadata) {
    return null;
  }


  const quality =
    metadata.qualities.find(
      (quality) =>
        quality.index === qualityIndex
    );


  if (!quality) {
    return null;
  }


  return (
    quality.segments.find(
      (segment) =>
        segment.segment ===
        segmentNumber
    ) ?? null
  );
}