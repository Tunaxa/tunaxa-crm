import { z } from "zod";

export const userFormSchema = z.object({
  name: z
    .string()
    .min(2, "Le nom doit contenir au moins 2 caractères"),

  email: z
    .string()
    .email("Adresse email invalide"),

  role: z
    .string()
    .min(1, "Veuillez sélectionner un rôle"),

  description: z
    .string()
    .max(500, "La description ne doit pas dépasser 500 caractères")
    .optional(),
});

export type UserFormValues = z.infer<typeof userFormSchema>;