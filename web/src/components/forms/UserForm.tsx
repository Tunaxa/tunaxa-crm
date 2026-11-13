import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";

import { FormInput } from "./FormInput";
import { FormSelect } from "./FormSelect";
import { FormTextarea } from "./FormTextarea";
import { userFormSchema, type UserFormValues } from "./formSchemas";

export interface UserFormProps {
  onSubmit: (data: UserFormValues) => void | Promise<void>;
}

export function UserForm({ onSubmit }: UserFormProps) {
  const {
    control,
    handleSubmit,
    formState: { isSubmitting },
  } = useForm<UserFormValues>({
    resolver: zodResolver(userFormSchema),
    defaultValues: {
      name: "",
      email: "",
      role: "",
      description: "",
    },
  });

  return (
    <form
      className="user-form"
      onSubmit={handleSubmit(onSubmit)}
      aria-busy={isSubmitting || undefined}
      noValidate
    >
      <FormInput
        name="name"
        control={control}
        label="Nom"
        placeholder="Votre nom"
        autoComplete="name"
        required
      />

      <FormInput
        name="email"
        control={control}
        label="Email"
        type="email"
        placeholder="exemple@email.com"
        autoComplete="email"
        required
      />

      <FormSelect
        name="role"
        control={control}
        label="Rôle"
        options={[
          { value: "admin", label: "Administrateur" },
          { value: "user", label: "Utilisateur" },
        ]}
        required
      />

      <FormTextarea
        name="description"
        control={control}
        label="Description"
        placeholder="Description..."
      />

      <button type="submit" className="btn primary" disabled={isSubmitting}>
        {isSubmitting ? "Envoi..." : "Enregistrer"}
      </button>
    </form>
  );
}
