{% if append_system %}
<addendum>
{{ append_system }}
</addendum>
{% endif %}
{% if project_context %}
<project_context>
{{ project_context }}
</project_context>
{% endif %}
{% if skills_prompt %}
<skills>
{{ skills_prompt }}
</skills>
{% endif %}
<cwd>
{{ cwd }}
</cwd>