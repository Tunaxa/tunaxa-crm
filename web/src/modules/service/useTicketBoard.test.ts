import { describe, expect, it, vi } from "vitest";
import { fetchTicketBoard } from "./useTicketBoard";

const ticketRows = (first: number, count: number) => Array.from({ length: count }, (_, index) => ({
  id: `ticket-${first + index}`,
  subject: `Ticket ${first + index}`,
  stage: "New",
}));

const page = (data: unknown[], total: number) => ({
  data,
  total,
  stages: [{ stage: "New" }],
  sla: { firstResponseHours: 4, resolutionHours: 48 },
});

describe("full ticket board loading", () => {
  it("collects all 120 tickets across two 100-row pages before assembling the board", async () => {
    const fetcher = vi.fn(async (path: string) => {
      if (path === "/tickets?page=1&limit=100") return page(ticketRows(1, 100), 120);
      if (path === "/tickets?page=2&limit=100") return page(ticketRows(101, 20), 120);
      throw new Error(`Unexpected path: ${path}`);
    });

    const board = await fetchTicketBoard(fetcher);

    expect(board.data).toHaveLength(120);
    expect(board.total).toBe(120);
    expect(board.data[119].id).toBe("ticket-120");
    expect(fetcher.mock.calls).toEqual([
      ["/tickets?page=1&limit=100"],
      ["/tickets?page=2&limit=100"],
    ]);
  });

  it("rejects an empty next page instead of returning a partial board", async () => {
    const fetcher = vi.fn(async (path: string) =>
      path === "/tickets?page=1&limit=100"
        ? page(ticketRows(1, 30), 120)
        : page([], 120),
    );

    await expect(fetchTicketBoard(fetcher)).rejects.toThrow("incomplete ticket board");
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
});
