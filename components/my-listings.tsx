"use client";

import { useMutation, useQuery } from "convex/react";
import { Archive, Pencil, Plus } from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import { toast } from "sonner";

import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { AvailabilityPill } from "@/components/status-pill";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import { formatDate } from "@/lib/dates";
import { errorMessage } from "@/lib/errors";
import {
  CATEGORY_LABELS,
  CATEGORY_ORDER,
  CONDITION_LABELS,
  type Category,
  type Condition,
  categoryLabel,
  conditionLabel,
} from "@/lib/labels";

type Listing = {
  id: Id<"tools">;
  name: string;
  category: string;
  condition: string;
  description: string;
  availability: { state: "available" | "lent"; until: number | null };
  archivedAt: number | null;
};

export function MyListings() {
  const listings = useQuery(api.tools.myListings);
  const archive = useMutation(api.tools.archive);
  const [editing, setEditing] = useState<Listing | null>(null);
  const [creating, setCreating] = useState(false);

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between gap-4">
        <p className="text-muted-foreground text-sm">
          {listings === undefined ? (
            "Loading your listings…"
          ) : (
            <ActiveCount
              active={listings.filter((item) => !item.archivedAt).length}
              total={listings.length}
            />
          )}
        </p>
        <Button size="sm" onClick={() => setCreating(true)}>
          <Plus className="size-4" />
          New listing
        </Button>
      </div>

      {listings === undefined ? (
        <div className="space-y-3">
          {Array.from({ length: 3 }).map((_, index) => (
            <Skeleton key={index} className="h-20 w-full rounded-xl" />
          ))}
        </div>
      ) : listings.length === 0 ? (
        <div className="text-muted-foreground flex flex-col items-center gap-3 rounded-xl border border-dashed py-20 text-sm">
          <p>You haven&apos;t listed anything yet.</p>
          <Button size="sm" variant="outline" onClick={() => setCreating(true)}>
            Add your first tool
          </Button>
        </div>
      ) : (
        <div className="space-y-3">
          {listings.map((listing) => (
            <Card key={listing.id} className="py-0">
              <CardContent className="flex flex-wrap items-center justify-between gap-4 p-5">
                <div className="min-w-0 space-y-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <Link
                      href={`/tools/${listing.id}`}
                      className="truncate font-medium hover:underline"
                    >
                      {listing.name}
                    </Link>
                    {listing.archivedAt ? (
                      <span className="text-muted-foreground font-mono text-[11px] uppercase">
                        Removed
                      </span>
                    ) : (
                      <AvailabilityPill
                        state={listing.availability.state}
                        until={listing.availability.until}
                        formatDate={formatDate}
                      />
                    )}
                  </div>
                  <p className="text-muted-foreground text-xs">
                    {categoryLabel(listing.category)} ·{" "}
                    {conditionLabel(listing.condition)}
                  </p>
                </div>

                <div className="flex items-center gap-1">
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={Boolean(listing.archivedAt)}
                    onClick={() => setEditing(listing)}
                  >
                    <Pencil className="size-3.5" />
                    Edit
                  </Button>
                  <RemoveButton
                    disabled={Boolean(listing.archivedAt)}
                    onRemove={async () => {
                      try {
                        await archive({ id: listing.id });
                        toast.success("Listing removed.");
                      } catch (error) {
                        toast.error(errorMessage(error));
                      }
                    }}
                  />
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      <ListingDialog
        open={creating}
        onOpenChange={setCreating}
        onSaved={() => setCreating(false)}
      />
      <ListingDialog
        open={editing !== null}
        onOpenChange={(open) => !open && setEditing(null)}
        listing={editing ?? undefined}
        onSaved={() => setEditing(null)}
      />
    </div>
  );
}

function ListingDialog({
  open,
  onOpenChange,
  listing,
  onSaved,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  listing?: Listing;
  onSaved: () => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{listing ? "Edit listing" : "List a tool"}</DialogTitle>
          <DialogDescription>
            Neighbors see this when they browse the board. Keep it short and honest.
          </DialogDescription>
        </DialogHeader>
        {/* Keyed so switching listings remounts the form with fresh initial state. */}
        <ListingForm
          key={listing?.id ?? "new"}
          listing={listing}
          onCancel={() => onOpenChange(false)}
          onSaved={onSaved}
        />
      </DialogContent>
    </Dialog>
  );
}

function ListingForm({
  listing,
  onCancel,
  onSaved,
}: {
  listing?: Listing;
  onCancel: () => void;
  onSaved: () => void;
}) {
  const create = useMutation(api.tools.create);
  const update = useMutation(api.tools.update);

  const [name, setName] = useState(listing?.name ?? "");
  const [category, setCategory] = useState<Category>(
    (listing?.category as Category) ?? "power-tools",
  );
  const [condition, setCondition] = useState<Condition>(
    (listing?.condition as Condition) ?? "good",
  );
  const [description, setDescription] = useState(listing?.description ?? "");
  const [busy, setBusy] = useState(false);

  return (
    <form
      className="space-y-4"
      onSubmit={async (event) => {
        event.preventDefault();
        setBusy(true);
        try {
          if (listing) {
            await update({ id: listing.id, name, category, condition, description });
            toast.success("Listing updated.");
          } else {
            await create({ name, category, condition, description });
            toast.success("Tool listed.");
          }
          onSaved();
        } catch (error) {
          toast.error(errorMessage(error));
        } finally {
          setBusy(false);
        }
      }}
    >
      <div className="space-y-1.5">
        <Label htmlFor="tool-name">Name</Label>
        <Input
          id="tool-name"
          value={name}
          onChange={(event) => setName(event.target.value)}
          placeholder="Cordless drill"
          maxLength={80}
          required
        />
      </div>

      <div className="grid grid-cols-2 gap-3">
        <div className="space-y-1.5">
          <Label htmlFor="tool-category">Category</Label>
          <Select
            value={category}
            onValueChange={(value) => setCategory(value as Category)}
          >
            <SelectTrigger id="tool-category">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {CATEGORY_ORDER.map((value) => (
                <SelectItem key={value} value={value}>
                  {CATEGORY_LABELS[value]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="tool-condition">Condition</Label>
          <Select
            value={condition}
            onValueChange={(value) => setCondition(value as Condition)}
          >
            <SelectTrigger id="tool-condition">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {(Object.keys(CONDITION_LABELS) as Condition[]).map((value) => (
                <SelectItem key={value} value={value}>
                  {CONDITION_LABELS[value]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="tool-description">Description</Label>
        <Textarea
          id="tool-description"
          value={description}
          onChange={(event) => setDescription(event.target.value)}
          placeholder="What's included, anything worth knowing before someone borrows it."
          rows={4}
          maxLength={500}
          required
        />
        <p className="text-muted-foreground text-right font-mono text-[11px]">
          {description.length}/500
        </p>
      </div>

      <DialogFooter>
        <Button type="button" variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
        <Button type="submit" disabled={busy}>
          {listing ? "Save changes" : "List tool"}
        </Button>
      </DialogFooter>
    </form>
  );
}

function ActiveCount({ active, total }: { active: number; total: number }) {
  if (total === 0) return <>No listings yet</>;
  return (
    <>
      {active} active {active === 1 ? "listing" : "listings"}
      {total > active ? ` · ${total - active} removed` : null}
    </>
  );
}

/**
 * Removing a listing is permanent (the row is kept for loan history but cannot be
 * restored from the UI), so it asks first.
 */
function RemoveButton({
  disabled,
  onRemove,
}: {
  disabled: boolean;
  onRemove: () => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);

  return (
    <AlertDialog>
      <AlertDialogTrigger asChild>
        <Button variant="ghost" size="sm" disabled={disabled}>
          <Archive className="size-3.5" />
          Remove
        </Button>
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Remove this listing?</AlertDialogTitle>
          <AlertDialogDescription>
            Neighbors will no longer see it and it cannot be restored from here. Existing
            loan history is kept.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Keep it</AlertDialogCancel>
          <AlertDialogAction
            disabled={busy}
            onClick={async (event) => {
              event.preventDefault();
              setBusy(true);
              try {
                await onRemove();
              } finally {
                setBusy(false);
              }
            }}
          >
            {busy ? "Removing…" : "Remove listing"}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
