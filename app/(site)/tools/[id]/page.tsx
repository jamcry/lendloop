import type { Id } from "@/convex/_generated/dataModel";
import { ToolDetail } from "@/components/tool-detail";

export const metadata = { title: "Tool" };

/** Convex ids are fixed-length, url-safe strings; anything else can't exist. */
const CONVEX_ID = /^[a-z0-9]{20,40}$/;

export default async function ToolPage({ params }: PageProps<"/tools/[id]">) {
  const { id } = await params;

  if (!CONVEX_ID.test(id)) {
    return (
      <div className="mx-auto w-full max-w-4xl px-4 py-16 sm:px-6">
        <h1 className="font-medium">This listing does not exist</h1>
      </div>
    );
  }

  return (
    <div className="mx-auto w-full max-w-4xl px-4 py-10 sm:px-6">
      <ToolDetail toolId={id as Id<"tools">} />
    </div>
  );
}
